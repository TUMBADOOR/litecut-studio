// Conexión con asistentes de IA (proceso principal): servidor MCP local, puente con la interfaz (donde se ejecutan
// los comandos sobre el proyecto), análisis con FFmpeg y la configuración para Claude Desktop, Gemini CLI y otras apps.
import { app, ipcMain, clipboard, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { AiServer } from './ai-server.js';
import { detectSilences, detectScenes, sampleFrames, grabFrame } from './ffmpeg.js';
import { JobQueue, writeFileAtomic } from './storage.js';

const SERVER_KEY = 'litecut';

export function setupAi({ storage, userData, cacheDir, tempDir, srcDir, getWindow, allowWrite, cacheKey, isTest }) {
  const prefs = storage.readJson('ia.json', { enabled: false });
  // Las pruebas automáticas pueden activarla sin tocar las preferencias guardadas.
  const enabledNow = () => prefs.enabled || (isTest && process.env.LITECUT_AI === '1');
  const portable = !!process.env.PORTABLE_EXECUTABLE_FILE; // la versión portable se descomprime en otra carpeta cada vez
  const calls = new Map();
  let seq = 0;
  let rendererReady = false;

  const send = (channel, payload) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  };

  const launch = portable ? null : { command: process.execPath, args: app.isPackaged ? [] : [app.getAppPath()] };
  const server = new AiServer({ dir: userData, version: app.getVersion(), launch, callTool: callRenderer, onStatus: () => send('ai:status', fullStatus()) });
  server.enabled = enabledNow();

  // ---------- Las herramientas se ejecutan en la interfaz (store, historial, vista previa) ----------
  function callRenderer(name, args, { progress, signal, client }) {
    const win = getWindow();
    if (!win || win.isDestroyed() || !rendererReady) return Promise.reject(new Error('LiteCut Studio todavía se está abriendo. Vuelve a intentarlo en unos segundos.'));
    return new Promise((resolve, reject) => {
      const id = ++seq;
      calls.set(id, { resolve, reject, progress });
      signal?.addEventListener('abort', () => send('ai:cancel', id), { once: true });
      win.webContents.send('ai:call', { id, name, args, client: client?.title || client?.name || '' });
    });
  }

  function rejectAll(message) {
    for (const c of calls.values()) c.reject(new Error(message));
    calls.clear();
  }

  ipcMain.on('ai:result', (_e, id, res) => {
    const c = calls.get(id);
    if (!c) return;
    calls.delete(id);
    if (res?.ok) c.resolve(res.value);
    else c.reject(new Error(res?.error || 'Error desconocido'));
  });
  ipcMain.on('ai:progress', (_e, id, p) => calls.get(id)?.progress?.(p));
  ipcMain.on('ai:ready', () => {
    rendererReady = true;
    if (server.enabled) server.start().catch(() => server.writeFiles());
    else server.writeFiles(); // el puente sabrá que la conexión está desactivada
    send('ai:status', fullStatus());
  });

  const progressFor = (callId, message) => (fraction) => calls.get(callId)?.progress?.({ progress: Math.round(fraction * 100), total: 100, message });

  // ---------- Configuración para las apps de IA ----------
  function bridgeConfig() {
    const bridge = app.isPackaged ? path.join(process.resourcesPath, 'app.asar.unpacked', 'src', 'mcp', 'litecut-mcp.cjs') : path.join(srcDir, 'mcp', 'litecut-mcp.cjs');
    const args = [bridge];
    // El puente busca la carpeta de datos habitual; si es otra (pruebas), se le indica.
    if (path.resolve(userData) !== path.resolve(app.getPath('appData'), 'LiteCut Studio')) args.push('--dir', userData);
    return { command: process.execPath, args, env: { ELECTRON_RUN_AS_NODE: '1' } };
  }

  function claudeConfigFiles() {
    if (process.platform === 'darwin') return [path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')];
    if (process.platform !== 'win32') return [path.join(os.homedir(), '.config', 'Claude', 'claude_desktop_config.json')];
    const out = [path.join(app.getPath('appData'), 'Claude', 'claude_desktop_config.json')];
    // Versión de Claude de la Microsoft Store: su carpeta de datos está virtualizada.
    const pk = path.join(process.env.LOCALAPPDATA || '', 'Packages');
    try {
      for (const d of fs.readdirSync(pk)) if (/^(Anthropic\.)?Claude_/i.test(d)) out.push(path.join(pk, d, 'LocalCache', 'Roaming', 'Claude', 'claude_desktop_config.json'));
    } catch {
      /* sin carpeta Packages */
    }
    return out;
  }

  const geminiConfigFile = () => path.join(os.homedir(), '.gemini', 'settings.json');

  function fullStatus() {
    return { ...server.status(), enabled: enabledNow(), portable, config: bridgeConfig(), files: { claude: claudeConfigFiles()[0], gemini: geminiConfigFile() } };
  }

  // Añade (o actualiza) LiteCut en el archivo de configuración de otra app, con copia de seguridad del original.
  function mergeServer(file, entry) {
    let data = {};
    let backup = null;
    if (fs.existsSync(file)) {
      const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
      if (text.trim()) {
        try {
          data = JSON.parse(text);
        } catch {
          throw new Error(`No se pudo leer ${file} (no es JSON estándar; quizá tiene comentarios). Copia la configuración y pégala a mano.`);
        }
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(`${file} no tiene el formato esperado. Pega la configuración a mano.`);
        backup = `${file}.antes-de-litecut`;
        if (!fs.existsSync(backup)) fs.copyFileSync(file, backup);
      }
    }
    data.mcpServers = { ...(data.mcpServers && typeof data.mcpServers === 'object' ? data.mcpServers : {}), [SERVER_KEY]: entry };
    writeFileAtomic(file, `${JSON.stringify(data, null, 2)}\n`);
    return { file, backup };
  }

  function install(target) {
    try {
      if (portable) throw new Error('La versión portable cambia de carpeta cada vez que se abre: instala LiteCut con el instalador para conectar tu IA.');
      const cfg = bridgeConfig();
      if (target === 'gemini') {
        const file = geminiConfigFile();
        if (!fs.existsSync(path.dirname(file))) throw new Error('No se encontró Gemini CLI en este equipo (carpeta .gemini). Instálalo, ábrelo una vez y vuelve a pulsar este botón.');
        return { ok: true, files: [mergeServer(file, { ...cfg, timeout: 600000 })] };
      }
      const files = claudeConfigFiles().filter((f) => fs.existsSync(path.dirname(f)));
      if (!files.length) throw new Error('No se encontró Claude Desktop en este equipo. Instálalo desde claude.ai/download, ábrelo una vez y vuelve a pulsar este botón.');
      return { ok: true, files: files.map((f) => mergeServer(f, cfg)) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  ipcMain.handle('ai:status', () => fullStatus());
  ipcMain.handle('ai:setEnabled', async (_e, v) => {
    prefs.enabled = !!v;
    storage.writeJson('ia.json', prefs);
    server.enabled = enabledNow();
    try {
      if (server.enabled && rendererReady) await server.start();
      else if (!server.enabled) await server.stop();
    } catch (err) {
      return { ...fullStatus(), error: err.message };
    }
    return fullStatus();
  });
  ipcMain.handle('ai:install', (_e, target) => install(target));
  ipcMain.handle('ai:copy', (_e, text) => clipboard.writeText(String(text)));
  ipcMain.handle('ai:showConfig', (_e, target) => {
    const file = target === 'gemini' ? geminiConfigFile() : claudeConfigFiles().find((f) => fs.existsSync(f));
    if (file && fs.existsSync(file)) shell.showItemInFolder(file);
    return !!file && fs.existsSync(file);
  });
  ipcMain.handle('ai:saveProject', (_e, file, text, { overwrite = false } = {}) => {
    try {
      if (!path.isAbsolute(file) || !/\.lcproj$/i.test(file)) throw new Error('La ruta debe ser absoluta y terminar en .lcproj');
      if (fs.existsSync(file) && !overwrite) throw new Error(`Ya existe ${file}`);
      writeFileAtomic(file, text);
      allowWrite(file);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // ---------- Análisis con FFmpeg (de uno en uno y con caché) ----------
  const jobs = new JobQueue(1);
  const memo = new Map();
  async function cachedAnalysis(kind, file, params, compute) {
    const key = `${cacheKey(file)}-${kind}-${crypto.createHash('sha1').update(JSON.stringify(params)).digest('hex').slice(0, 10)}`;
    if (memo.has(key)) return memo.get(key);
    const disk = path.join(cacheDir, 'analysis', `${key}.json`);
    try {
      const v = JSON.parse(fs.readFileSync(disk, 'utf8'));
      memo.set(key, v);
      return v;
    } catch {
      /* sin caché */
    }
    const v = await jobs.run(compute);
    if (v.complete) {
      memo.set(key, v);
      try {
        fs.mkdirSync(path.dirname(disk), { recursive: true });
        fs.writeFileSync(disk, JSON.stringify(v));
      } catch {
        /* no se pudo guardar la caché */
      }
    }
    return v;
  }

  const wrap = (fn) => async (_e, o) => {
    try {
      return { ok: true, value: await fn(o) };
    } catch (err) {
      return { ok: false, error: err.message, details: err.details || '' };
    }
  };

  ipcMain.handle(
    'ai:silences',
    wrap((o) =>
      cachedAnalysis('silencios', o.file, { n: o.noise, d: o.minDuration }, () =>
        detectSilences(o.file, { noise: o.noise, minDuration: o.minDuration, duration: o.duration, maxSeconds: 110, onProgress: progressFor(o.callId, 'Buscando silencios…') })
      )
    )
  );
  ipcMain.handle(
    'ai:scenes',
    wrap((o) =>
      cachedAnalysis('escenas', o.file, { t: o.threshold, s: o.start, d: o.duration }, () =>
        detectScenes(o.file, { threshold: o.threshold, start: o.start, duration: o.duration, maxSeconds: 45, onProgress: progressFor(o.callId, 'Buscando cambios de escena…') })
      )
    )
  );
  ipcMain.handle(
    'ai:samples',
    wrap((o) =>
      jobs.run(async () => {
        const mimeType = o.format === 'png' ? 'image/png' : 'image/jpeg';
        const opts = { width: o.width, format: o.format };
        let frames = [];
        if (o.isImage) frames = [{ time: 0, buf: await grabFrame(o.file, 0, opts) }];
        else {
          const dir = path.join(tempDir, `ia-muestras-${crypto.randomBytes(4).toString('hex')}`);
          try {
            const span = o.end - o.start;
            const long = span > 45;
            // Tramos cortos: una pasada decodificando todo. Largos: solo fotogramas clave (salvo AV1, que no sabe saltar).
            if (!long || o.vcodec !== 'av1') {
              const list = await sampleFrames(o.file, dir, { start: o.start, end: o.end, count: o.count, ...opts, keyframesOnly: long });
              frames = list.map((f) => ({ time: f.time, buf: fs.readFileSync(f.file) }));
            }
            if (frames.length < Math.min(o.count, long ? Math.ceil(o.count / 2) : 2)) {
              frames = [];
              for (let i = 0; i < o.count; i++) {
                const t = o.start + (span * (i + 0.5)) / o.count;
                frames.push({ time: t, buf: await grabFrame(o.file, t, opts) });
              }
            }
          } finally {
            fs.rmSync(dir, { recursive: true, force: true });
          }
        }
        return frames.map((f) => ({ time: f.time, data: f.buf.toString('base64'), mimeType }));
      })
    )
  );

  return {
    onWindow(win) {
      win.webContents.on('did-start-loading', () => {
        rendererReady = false;
        rejectAll('LiteCut Studio se está recargando. Vuelve a intentarlo en unos segundos.');
      });
      win.on('closed', () => {
        rendererReady = false;
        rejectAll('LiteCut Studio se cerró.');
      });
    },
    shutdown() {
      server.shutdown();
    },
  };
}
