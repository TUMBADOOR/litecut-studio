// Proceso principal de LiteCut Studio.
import { app, BrowserWindow, ipcMain, dialog, protocol, net, shell, Menu, screen } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Readable } from 'node:stream';
import {
  ffmpegPath,
  ffmpegVersion,
  filterScriptArgs,
  probe,
  extractThumbs,
  extractPeaks,
  extractPcm,
  measureLoudness,
  reverseRange,
  makeProxy,
  extractFrame,
  detectHardwareEncoders,
  encoderArgs,
  runFfmpeg,
  progressParser,
  lastLines,
} from './ffmpeg.js';
import { buildExportGraphAuto } from '../shared/export-graph.js';
import { analyzeBeats } from '../shared/beats.js';
import { buildMenu } from './menu.js';
import { Storage, JobQueue, writeFileAtomic } from './storage.js';
import { RecorderController } from './recorder.js';
import { setupAi } from './ai.js';
import { setupAssistant } from './assistant.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, '..');
const RENDERER = path.join(SRC, 'renderer');
const SHARED = path.join(SRC, 'shared');
const PRELOAD = path.join(__dirname, 'preload.cjs');
const isMac = process.platform === 'darwin';
const TEST_SCRIPT = process.env.LITECUT_TEST || null;

app.setName('LiteCut Studio');
// Las pruebas automáticas pueden usar su propia carpeta de datos (no tocan el autoguardado del usuario).
if (TEST_SCRIPT && process.env.LITECUT_USER_DATA) app.setPath('userData', process.env.LITECUT_USER_DATA);
if (process.platform === 'win32') app.setAppUserModelId('com.litecut.studio');
// La prioridad de los procesos la gestiona la app (ver setAppPriority); Chromium no debe devolverla a «normal».
app.commandLine.appendSwitch('disable-renderer-priority-management');
if (isMac) {
  // Intento de audio del sistema en macOS 13+ (si la versión de Chromium lo soporta).
  app.commandLine.appendSwitch('enable-features', 'MacLoopbackAudioForScreenShare,MacSckSystemAudioLoopbackOverride');
}

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
  { scheme: 'media', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, bypassCSP: true } },
]);

const appUrl = (p) => `app://bundle/${p}`;

// ---------- Rutas de datos ----------
const userData = app.getPath('userData');
// Miniaturas, ondas y proxies (no usar "cache": en Windows coincide con la carpeta Cache de Chromium).
const cacheDir = path.join(userData, 'media-cache');
// Las pruebas usan otra carpeta temporal: al arrancar se vacía y no deben tocar la de una LiteCut abierta.
const tempDir = path.join(app.getPath('temp'), TEST_SCRIPT ? 'litecut-studio-prueba' : 'litecut-studio');
const recordingsDir = (TEST_SCRIPT && process.env.LITECUT_RECORDINGS_DIR) || path.join(app.getPath('videos'), 'LiteCut Studio');
const storage = new Storage(userData);
const fastJobs = new JobQueue(2);
const proxyJobs = new JobQueue(1);
const allowedWrites = new Set();

let mainWindow = null;
let forceClose = false;
let dirty = false;
let pendingOpen = null;
let exportJob = null;
let hwPromise = null;
let versionPromise = null;
let ai = null;
let assistant = null;

const getVersion = () => (versionPromise ||= ffmpegVersion());
const getHw = () =>
  (hwPromise ||= (async () => {
    const v = await getVersion();
    const key = `${v.text}|${process.platform}|${process.arch}`;
    const cached = storage.readJson('hw.json', null);
    if (cached && cached.key === key) return cached.result;
    const result = await detectHardwareEncoders().catch(() => ({ h264: null, hevc: null }));
    storage.writeJson('hw.json', { key, result });
    return result;
  })());

const recorder = new RecorderController({
  getMainWindow: () => mainWindow,
  preload: PRELOAD,
  appUrl,
  recordingsDir,
  tempDir,
  getHw,
  isMac,
});

// ---------- Utilidades ----------
const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.woff2': 'font/woff2',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.ogv': 'video/ogg',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.flac': 'audio/flac',
};
const mimeFor = (f) => MIME[path.extname(f).toLowerCase()] || 'application/octet-stream';

function cacheKey(file) {
  const st = fs.statSync(file);
  return crypto.createHash('sha1').update(`${file}|${st.size}|${st.mtimeMs}`).digest('hex').slice(0, 20);
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function errInfo(err) {
  return { message: err?.message || String(err), details: err?.details || '' };
}

// ---------- Rendimiento ----------
// Mientras la ventana está en primer plano, los procesos de la app (interfaz, gráfica, audio y el que sirve
// los archivos) tienen prioridad sobre los programas normales: la vista previa y el sonido no se traban
// aunque otros programas usen mucha CPU. Al pasar a segundo plano vuelven a la prioridad normal.
function setAppPriority(boost) {
  const { PRIORITY_ABOVE_NORMAL, PRIORITY_NORMAL } = os.constants.priority;
  for (const m of app.getAppMetrics()) {
    const audio = m.type === 'Utility' && /audio/i.test(`${m.serviceName || ''} ${m.name || ''}`);
    if (m.type !== 'Browser' && m.type !== 'GPU' && m.type !== 'Tab' && !audio) continue;
    try {
      os.setPriority(m.pid, boost ? PRIORITY_ABOVE_NORMAL : PRIORITY_NORMAL);
    } catch {
      /* sin permiso (p. ej. macOS no permite subirla): se queda como está */
    }
  }
}

function gpuNameFrom(renderer) {
  const m = /^ANGLE \((.*)\)$/.exec(renderer || '');
  const parts = (m ? m[1] : renderer || '').split(', ');
  const name = (parts[1] || parts[0] || '').replace('ANGLE Metal Renderer: ', '').replace(/\s*\(0x[0-9a-f]+\).*$/i, '').replace(/\s+Direct3D.*$/i, '');
  return name.trim() || null;
}

// Perfil del equipo para adaptar la app: procesador, memoria, gráfica y codificador por hardware.
let deviceInfo = null;
async function deviceProfile() {
  if (!deviceInfo) {
    const cpus = os.cpus();
    const cores = cpus.length || 2;
    const ramGB = os.totalmem() / 2 ** 30;
    const gpu = await app.getGPUInfo('complete').catch(() => null);
    const hw = await getHw().catch(() => null);
    deviceInfo = {
      cpu: (cpus[0]?.model || '').replace(/\s+/g, ' ').trim(),
      cores,
      ramGB,
      gpu: gpuNameFrom(gpu?.auxAttributes?.glRenderer),
      hwEncoder: hw?.h264 || null,
      // «low»: 4 núcleos o menos, o menos de 6 GB de memoria (portátiles Celeron/Pentium/Atom y similares).
      tier: cores <= 4 || ramGB < 6 ? 'low' : cores < 8 || ramGB < 12 ? 'mid' : 'high',
    };
  }
  return { ...deviceInfo, freeRamGB: os.freemem() / 2 ** 30 };
}

// ---------- Protocolos ----------
function registerProtocols() {
  protocol.handle('app', (req) => {
    const u = new URL(req.url);
    let rel = decodeURIComponent(u.pathname);
    let base = RENDERER;
    if (rel.startsWith('/shared/')) {
      base = SHARED;
      rel = rel.slice('/shared'.length);
    }
    const file = path.normalize(path.join(base, rel));
    if (!file.startsWith(base)) return new Response('Prohibido', { status: 403 });
    return net.fetch(pathToFileURL(file).toString()).then(
      (r) => new Response(r.body, { status: r.status, headers: { 'Content-Type': mimeFor(file) } })
    );
  });

  // media://local/<ruta codificada> — sirve archivos locales con soporte de rangos (necesario para buscar en videos).
  protocol.handle('media', async (req) => {
    let file;
    try {
      file = decodeURIComponent(new URL(req.url).pathname.slice(1));
    } catch {
      return new Response('Ruta inválida', { status: 400 });
    }
    let st;
    try {
      st = await fs.promises.stat(file);
      if (!st.isFile()) throw new Error('no es archivo');
    } catch {
      return new Response('No encontrado', { status: 404 });
    }
    const size = st.size;
    const headers = {
      'Content-Type': mimeFor(file),
      'Accept-Ranges': 'bytes',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    };
    const range = req.headers.get('range');
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      let start = m && m[1] ? parseInt(m[1], 10) : 0;
      let end = m && m[2] ? parseInt(m[2], 10) : size - 1;
      if (m && !m[1] && m[2]) {
        start = Math.max(0, size - parseInt(m[2], 10));
        end = size - 1;
      }
      end = Math.min(end, size - 1);
      if (start >= size || start > end) {
        return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${size}` } });
      }
      const stream = fs.createReadStream(file, { start, end });
      return new Response(Readable.toWeb(stream), {
        status: 206,
        headers: { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1) },
      });
    }
    return new Response(Readable.toWeb(fs.createReadStream(file)), { status: 200, headers: { ...headers, 'Content-Length': String(size) } });
  });
}

// ---------- Ventana principal ----------
function createMainWindow() {
  const wa = screen.getPrimaryDisplay().workArea;
  const small = wa.width < 1500 || wa.height < 900;
  mainWindow = new BrowserWindow({
    width: Math.min(1440, wa.width),
    height: Math.min(900, wa.height),
    minWidth: 1024,
    minHeight: 620,
    show: false,
    title: 'LiteCut Studio',
    backgroundColor: '#0f0f12',
    autoHideMenuBar: true,
    icon: path.join(RENDERER, 'assets', 'icon.png'),
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      spellcheck: false,
      autoplayPolicy: 'no-user-gesture-required',
      additionalArguments: TEST_SCRIPT ? ['--litecut-test'] : [],
    },
  });
  if (small) mainWindow.maximize();
  ai?.onWindow(mainWindow);
  assistant?.onWindow(mainWindow);
  Menu.setApplicationMenu(buildMenu((cmd) => send('menu', cmd), { isMac }));
  mainWindow.loadURL(appUrl('index.html'));
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (pendingOpen) {
      send('app:open-project', pendingOpen);
      pendingOpen = null;
    }
  });
  mainWindow.on('close', (e) => {
    if (!forceClose && dirty && !TEST_SCRIPT) {
      e.preventDefault();
      send('app:request-close');
    }
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  mainWindow.on('focus', () => setAppPriority(true));
  // Grabando la pantalla la ventana se minimiza, pero la grabación necesita la prioridad igual.
  mainWindow.on('blur', () => setAppPriority(!!recorder.active));
  // Algunos procesos (el de audio, por ejemplo) nacen después del foco: se repasa cada pocos segundos.
  const keepPriority = setInterval(() => {
    if (mainWindow && !mainWindow.isDestroyed() && (mainWindow.isFocused() || recorder.active)) setAppPriority(true);
  }, 5000);
  mainWindow.on('closed', () => clearInterval(keepPriority));
  // Abrir enlaces externos en el navegador del sistema.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('app://')) e.preventDefault();
  });
  if (TEST_SCRIPT) runTestScript();
}

// Modo de prueba automática: ejecuta un guion en la interfaz y guarda capturas.
function runTestScript() {
  const outDir = process.env.LITECUT_TEST_OUT || path.join(tempDir, 'test-out');
  fs.mkdirSync(outDir, { recursive: true });
  ipcMain.handle('test:capture', async (_e, name) => {
    const img = await mainWindow.webContents.capturePage();
    const file = path.join(outDir, `${name}.png`);
    fs.writeFileSync(file, img.toPNG());
    return file;
  });
  ipcMain.handle('test:log', (_e, msg) => {
    fs.appendFileSync(path.join(outDir, 'log.txt'), `${msg}\n`);
    return true;
  });
  ipcMain.handle('test:allowWrite', (_e, file) => {
    allowedWrites.add(file);
    return true;
  });
  // Como si el usuario usara el menú o su atajo (p. ej. «undo» = Ctrl+Z).
  ipcMain.handle('test:menu', (_e, cmd) => {
    send('menu', cmd);
    return true;
  });
  ipcMain.handle('test:recCommand', (_e, cmd) => {
    const bar = recorder.active?.bar;
    if (bar && !bar.isDestroyed()) bar.webContents.send('recbar:command', cmd);
    return !!bar;
  });
  ipcMain.handle('test:metrics', () =>
    app.getAppMetrics().map((m) => ({ pid: m.pid, type: m.type, name: m.serviceName || m.name || '', cpu: m.cpu.percentCPUUsage, ramMB: Math.round(m.memory.workingSetSize / 1024) }))
  );
  ipcMain.handle('test:done', (_e, code) => {
    forceClose = true;
    ai?.shutdown(); // app.exit() no emite «will-quit»
    setTimeout(() => app.exit(code || 0), 200);
    return true;
  });
  mainWindow.webContents.on('console-message', (event, level, message) => {
    const msg = event.message ?? message ?? '';
    fs.appendFileSync(path.join(outDir, 'console.txt'), `[${event.level ?? level}] ${msg}\n`);
  });
  mainWindow.webContents.once('did-finish-load', () => {
    const code = fs.readFileSync(TEST_SCRIPT, 'utf8');
    setTimeout(() => mainWindow.webContents.executeJavaScript(code).catch((err) => fs.appendFileSync(path.join(outDir, 'log.txt'), `ERROR ${err}\n`)), 1500);
  });
}

// ---------- IPC ----------
function registerIpc() {
  ipcMain.handle('app:info', async () => ({
    platform: process.platform,
    arch: process.arch,
    version: app.getVersion(),
    isPackaged: app.isPackaged,
    ffmpeg: (await getVersion()).text,
    paths: { videos: app.getPath('videos'), recordings: recordingsDir, documents: app.getPath('documents'), pictures: app.getPath('pictures') },
  }));
  ipcMain.handle('device:profile', () => deviceProfile());
  ipcMain.on('win:dirty', (_e, v) => {
    dirty = !!v;
    if (mainWindow) mainWindow.setDocumentEdited?.(dirty);
  });
  ipcMain.on('win:title', (_e, t) => mainWindow && mainWindow.setTitle(String(t)));
  ipcMain.on('win:forceClose', () => {
    forceClose = true;
    if (mainWindow) mainWindow.close();
  });

  // Diálogos
  const mediaFilters = [
    { name: 'Medios', extensions: ['mp4', 'mov', 'm4v', 'mkv', 'webm', 'avi', 'wmv', 'flv', 'mpg', 'mpeg', 'ts', 'mts', 'm2ts', '3gp', 'ogv', 'gif', 'mp3', 'wav', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'flac', 'wma', 'aiff', 'aif', 'png', 'jpg', 'jpeg', 'webp', 'bmp', 'tif', 'tiff'] },
    { name: 'Video', extensions: ['mp4', 'mov', 'm4v', 'mkv', 'webm', 'avi', 'wmv', 'flv', 'mpg', 'mpeg', 'ts', 'mts', 'm2ts', '3gp', 'ogv', 'gif'] },
    { name: 'Audio', extensions: ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'flac', 'wma', 'aiff', 'aif'] },
    { name: 'Imágenes', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'tif', 'tiff'] },
    { name: 'Todos los archivos', extensions: ['*'] },
  ];
  ipcMain.handle('dialog:openMedia', async (_e, kind) => {
    const filters = kind === 'audio' ? [mediaFilters[2], mediaFilters[4]] : mediaFilters;
    const r = await dialog.showOpenDialog(mainWindow, { title: 'Importar medios', properties: ['openFile', 'multiSelections'], filters });
    return r.canceled ? [] : r.filePaths;
  });
  ipcMain.handle('dialog:openFile', async (_e, opts = {}) => {
    const r = await dialog.showOpenDialog(mainWindow, { title: opts.title || 'Abrir', properties: ['openFile'], filters: opts.filters || mediaFilters });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('dialog:openProject', async () => {
    const r = await dialog.showOpenDialog(mainWindow, { title: 'Abrir proyecto', properties: ['openFile'], filters: [{ name: 'Proyecto LiteCut', extensions: ['lcproj'] }] });
    if (r.canceled) return null;
    allowedWrites.add(r.filePaths[0]);
    return r.filePaths[0];
  });
  ipcMain.handle('dialog:saveProject', async (_e, name) => {
    const r = await dialog.showSaveDialog(mainWindow, {
      title: 'Guardar proyecto',
      defaultPath: path.join(app.getPath('documents'), `${sanitizeName(name || 'Proyecto')}.lcproj`),
      filters: [{ name: 'Proyecto LiteCut', extensions: ['lcproj'] }],
    });
    if (r.canceled || !r.filePath) return null;
    allowedWrites.add(r.filePath);
    return r.filePath;
  });
  ipcMain.handle('dialog:exportPath', async (_e, { name, ext, dir }) => {
    const base = dir && fs.existsSync(dir) ? dir : app.getPath('videos');
    const r = await dialog.showSaveDialog(mainWindow, {
      title: 'Exportar',
      defaultPath: path.join(base, `${sanitizeName(name || 'Video')}.${ext}`),
      filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
    });
    return r.canceled ? null : r.filePath;
  });
  ipcMain.handle('dialog:saveImage', async (_e, name) => {
    const r = await dialog.showSaveDialog(mainWindow, {
      title: 'Guardar fotograma',
      defaultPath: path.join(app.getPath('pictures'), `${sanitizeName(name || 'Fotograma')}.png`),
      filters: [{ name: 'PNG', extensions: ['png'] }],
    });
    if (r.canceled || !r.filePath) return null;
    allowedWrites.add(r.filePath);
    return r.filePath;
  });

  // Proyectos y archivos
  ipcMain.handle('project:read', async (_e, file) => {
    allowedWrites.add(file);
    return fs.promises.readFile(file, 'utf8');
  });
  ipcMain.handle('project:write', async (_e, file, text) => {
    if (!allowedWrites.has(file)) throw new Error('Ruta no autorizada');
    writeFileAtomic(file, text);
    return true;
  });
  ipcMain.handle('fs:writeBinary', async (_e, file, data) => {
    if (!allowedWrites.has(file)) throw new Error('Ruta no autorizada');
    await fs.promises.writeFile(file, Buffer.from(data));
    return true;
  });
  ipcMain.handle('fs:exists', (_e, files) => (files || []).map((f) => !!f && fs.existsSync(f)));
  ipcMain.handle('fs:writeTemp', async (_e, name, data) => {
    fs.mkdirSync(tempDir, { recursive: true });
    const file = path.join(tempDir, `${Date.now().toString(36)}_${sanitizeName(name)}`);
    await fs.promises.writeFile(file, Buffer.from(data));
    return file;
  });
  ipcMain.handle('fs:writeMedia', async (_e, name, data) => {
    // Archivos generados por la app que pasan a formar parte del proyecto (p. ej. capturas).
    const dir = path.join(recordingsDir, 'Imágenes');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, sanitizeName(name));
    await fs.promises.writeFile(file, Buffer.from(data));
    return file;
  });
  ipcMain.handle('recent:get', () => storage.getRecent());
  ipcMain.handle('recent:add', (_e, file, name) => storage.addRecent(file, name));
  ipcMain.handle('autosave:write', (_e, text, meta) => storage.autosave(text, meta));
  ipcMain.handle('autosave:read', () => storage.loadAutosave());
  ipcMain.handle('autosave:clear', () => storage.clearAutosave());
  ipcMain.handle('prefs:get', () => storage.readJson('prefs.json', {}));
  ipcMain.handle('prefs:set', (_e, prefs) => storage.writeJson('prefs.json', prefs));

  // Medios
  ipcMain.handle('media:probe', async (_e, file) => {
    try {
      const info = await probe(file);
      const st = fs.statSync(file);
      return { ok: true, info: { ...info, size: st.size } };
    } catch (err) {
      return { ok: false, error: errInfo(err) };
    }
  });
  ipcMain.handle('media:thumbs', async (_e, file, duration, opts = {}) => {
    try {
      const dir = path.join(cacheDir, 'thumbs', cacheKey(file));
      const index = path.join(dir, 'index.json');
      if (fs.existsSync(index)) {
        const list = JSON.parse(fs.readFileSync(index, 'utf8'));
        if (list.every((t) => fs.existsSync(t.file))) return list;
      }
      // El decodificador de AV1 no sabe saltar a los fotogramas clave: se busca cada miniatura por separado.
      const seek = opts.vcodec === 'av1';
      const count = seek ? 30 : duration > 1200 ? 120 : duration > 300 ? 80 : 40;
      const list = await fastJobs.run(() => extractThumbs(file, dir, { duration, count, height: 72, seek }));
      fs.writeFileSync(index, JSON.stringify(list));
      return list;
    } catch {
      return [];
    }
  });
  ipcMain.handle('media:peaks', async (_e, file) => {
    try {
      const key = cacheKey(file);
      const bin = path.join(cacheDir, 'peaks', `${key}.bin`);
      if (fs.existsSync(bin)) return { perSec: 50, data: new Uint8Array(fs.readFileSync(bin)) };
      const res = await fastJobs.run(() => extractPeaks(file, { perSec: 50 }));
      if (res.data.length) {
        fs.mkdirSync(path.dirname(bin), { recursive: true });
        fs.writeFileSync(bin, Buffer.from(res.data));
      }
      return { perSec: res.perSec, data: res.data };
    } catch {
      return { perSec: 50, data: new Uint8Array(0) };
    }
  });
  // start/end: solo ese tramo del archivo. cachedOnly: solo responde si ya existe (no convierte nada).
  ipcMain.handle('media:proxy', async (_e, { id, file, kind, duration, hasAudio, start = 0, end = 0, cachedOnly = false }) => {
    try {
      const ext = kind === 'audio' ? '.m4a' : kind === 'image' ? '.png' : '.mp4';
      const part = end > start ? `_${Math.round(start * 1000)}-${Math.round(end * 1000)}` : '';
      const out = path.join(cacheDir, 'proxies', `${cacheKey(file)}${part}${ext}`);
      if (fs.existsSync(out)) return { ok: true, path: out };
      if (cachedOnly) return { ok: false, missing: true };
      const length = part ? end - start : 0;
      await proxyJobs.run(() =>
        makeProxy(file, out, { kind, duration, hasAudio, start, length, onProgress: (p) => send('media:proxy-progress', { id, progress: p }) })
      );
      return { ok: true, path: out };
    } catch (err) {
      return { ok: false, error: errInfo(err) };
    }
  });
  // Pulsos de la música en un tramo del archivo (para poner marcadores al ritmo).
  ipcMain.handle('media:beats', async (_e, { file, start = 0, duration = 0 }) => {
    try {
      const rate = 8000;
      const pcm = await fastJobs.run(() => extractPcm(file, { start, duration, rate }));
      const r = analyzeBeats(pcm, rate);
      return { ok: true, bpm: r.bpm, beats: r.beats.map((t) => t + start) };
    } catch (err) {
      return { ok: false, error: errInfo(err) };
    }
  });
  ipcMain.handle('media:loudness', async (_e, { file, start = 0, duration = 0 }) => {
    try {
      return { ok: true, ...(await fastJobs.run(() => measureLoudness(file, { start, duration }))) };
    } catch (err) {
      return { ok: false, error: errInfo(err) };
    }
  });
  // Clip invertido: se guarda junto a las grabaciones (Videos/LiteCut Studio/Invertidos) porque pasa a ser
  // un archivo del proyecto.
  ipcMain.handle('media:reverse', async (_e, { id, file, name, start, duration, width, height, fps, hasVideo, hasAudio }) => {
    try {
      const dir = path.join(recordingsDir, 'Invertidos');
      const base = sanitizeName(`${String(name || 'Clip').replace(/\.[^.]+$/, '')} (invertido ${start.toFixed(2)}-${(start + duration).toFixed(2)} s)`);
      const out = path.join(dir, `${base}.mp4`);
      if (!fs.existsSync(out)) {
        await proxyJobs.run(() =>
          reverseRange(file, out, { start, duration, width, height, fps, hasVideo, hasAudio, onProgress: (p) => send('media:reverse-progress', { id, progress: p }) })
        );
      }
      return { ok: true, path: out };
    } catch (err) {
      return { ok: false, error: errInfo(err) };
    }
  });
  ipcMain.handle('media:frame', async (_e, file, time) => {
    try {
      const dir = path.join(recordingsDir, 'Imágenes');
      const out = path.join(dir, `Fotograma ${Date.now().toString(36)}.png`);
      await extractFrame(file, time, out);
      return { ok: true, path: out };
    } catch (err) {
      return { ok: false, error: errInfo(err) };
    }
  });

  // Exportación
  ipcMain.handle('export:caps', async () => {
    const hw = await getHw();
    return { hw, ffmpeg: (await getVersion()).text };
  });
  ipcMain.handle('export:start', async (_e, payload) => runExport(payload));
  ipcMain.handle('export:cancel', () => {
    if (exportJob) exportJob.ac.abort();
    return true;
  });

  // Shell
  ipcMain.handle('shell:showItem', (_e, file) => shell.showItemInFolder(file));
  ipcMain.handle('shell:openPath', (_e, file) => shell.openPath(file));
  ipcMain.handle('shell:openRecordings', () => {
    fs.mkdirSync(recordingsDir, { recursive: true });
    return shell.openPath(recordingsDir);
  });

  // Grabador
  ipcMain.handle('rec:permissions', () => recorder.permissions());
  ipcMain.handle('rec:askMedia', (_e, kind) => recorder.askMedia(kind));
  ipcMain.handle('rec:openPrivacy', (_e, kind) => recorder.openPrivacy(kind));
  ipcMain.handle('rec:sources', async () => {
    try {
      return { ok: true, sources: await recorder.sources() };
    } catch (err) {
      return { ok: false, error: errInfo(err) };
    }
  });
  ipcMain.handle('rec:displays', () => recorder.displays());
  ipcMain.handle('rec:selectRegion', async (_e, displayId) => {
    const hide = mainWindow && mainWindow.isVisible();
    if (hide) mainWindow.hide();
    try {
      return await recorder.selectRegion(displayId);
    } finally {
      if (hide && mainWindow) {
        mainWindow.show();
        mainWindow.focus();
      }
    }
  });
  ipcMain.handle('rec:start', async (_e, cfg) => {
    try {
      return await recorder.start(cfg);
    } catch (err) {
      return { ok: false, error: errInfo(err) };
    }
  });
  ipcMain.handle('recbar:config', () => recorder.barConfig());
  ipcMain.on('recbar:chunk', (_e, key, data) => recorder.chunk(key, data));
  ipcMain.handle('recbar:finish', (_e, payload) => recorder.finish(payload));
  ipcMain.on('recbar:resize', (e, w, h) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (win) {
      const b = win.getBounds();
      win.setBounds({ x: Math.round(b.x + (b.width - w) / 2), y: b.y, width: w, height: h });
    }
  });
  ipcMain.handle('voice:begin', () => recorder.voiceBegin());
  ipcMain.on('voice:chunk', (_e, id, data) => recorder.voiceChunk(id, data));
  ipcMain.handle('voice:end', async (_e, id, cancelled) => {
    try {
      return { ok: true, path: await recorder.voiceEnd(id, cancelled) };
    } catch (err) {
      return { ok: false, error: errInfo(err) };
    }
  });
}

function sanitizeName(name) {
  return String(name).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim().slice(0, 120) || 'archivo';
}

async function runExport(payload) {
  if (exportJob) return { ok: false, error: { message: 'Ya hay una exportación en curso.' } };
  const { project, settings, assets } = payload;
  const ac = new AbortController();
  exportJob = { ac };
  const scripts = [];
  try {
    const version = await getVersion();
    const fmt = settings.format;
    const gif = fmt === 'gif';
    const audioOnly = fmt === 'mp3' || fmt === 'wav';
    const graph = buildExportGraphAuto(
      project,
      { width: settings.width, height: settings.height, fps: settings.fps, gif, includeVideo: !audioOnly, includeAudio: !gif },
      assets || {}
    );
    const hw = settings.useHardware ? await getHw() : null;
    const hwEnc = fmt === 'mp4' ? hw?.h264 || null : fmt === 'mp4-hevc' ? hw?.hevc || null : null;
    const output = settings.output;
    fs.mkdirSync(path.dirname(output), { recursive: true });
    const ext = path.extname(output);
    const tmpOut = output.slice(0, output.length - ext.length) + `.litecut-tmp${ext}`;
    const t0 = Date.now();

    const attempt = async (enc) => {
      const e = encoderArgs({ format: fmt, quality: settings.quality, width: graph.width, height: graph.height, fps: settings.fps, hw: enc });
      const script = path.join(tempDir, `export_${Date.now().toString(36)}.txt`);
      fs.mkdirSync(tempDir, { recursive: true });
      fs.writeFileSync(script, graph.filter);
      scripts.push(script);
      const args = ['-hide_banner', '-y', '-nostdin', ...graph.inputs.flat(), ...filterScriptArgs(version, script)];
      if (graph.vout) args.push('-map', graph.vout, ...e.video, '-r', String(settings.fps));
      if (graph.aout) args.push('-map', graph.aout, ...e.audio);
      args.push(...e.extra, '-t', graph.total.toFixed(3), '-progress', 'pipe:1', '-nostats', tmpOut);
      send('export:progress', { percent: 0, time: 0, speed: 0, eta: null, encoder: enc || 'cpu' });
      return runFfmpeg(args, {
        signal: ac.signal,
        onStdout: progressParser(graph.total, (p) => {
          const elapsed = (Date.now() - t0) / 1000;
          const eta = p.percent > 0.01 ? (elapsed / p.percent) * (1 - p.percent) : null;
          send('export:progress', { ...p, eta, elapsed, encoder: enc || 'cpu' });
        }),
      });
    };

    let res = await attempt(hwEnc);
    let usedHw = hwEnc;
    if (res.code !== 0 && hwEnc && !res.killed) {
      usedHw = null;
      res = await attempt(null); // si falla la GPU, se reintenta con la CPU
    }
    if (res.killed) {
      fs.rmSync(tmpOut, { force: true });
      return { ok: false, cancelled: true };
    }
    if (res.code !== 0 || !fs.existsSync(tmpOut)) {
      fs.rmSync(tmpOut, { force: true });
      return { ok: false, error: { message: 'FFmpeg no pudo exportar el video.', details: lastLines(res.stderr, 16) } };
    }
    fs.rmSync(output, { force: true });
    fs.renameSync(tmpOut, output);
    return { ok: true, output, seconds: (Date.now() - t0) / 1000, encoder: usedHw || 'cpu', warnings: graph.warnings };
  } catch (err) {
    return { ok: false, error: errInfo(err) };
  } finally {
    exportJob = null;
    for (const s of scripts) fs.rmSync(s, { force: true });
    for (const a of Object.values(assets?.text || {})) if (a?.path?.startsWith(tempDir)) fs.rmSync(a.path, { force: true });
  }
}

// ---------- Ciclo de vida ----------
const gotLock = TEST_SCRIPT ? true : app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  const projectArg = (argv) => argv.find((a) => /\.lcproj$/i.test(a) && fs.existsSync(a));
  app.on('second-instance', (_e, argv) => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    const p = projectArg(argv);
    if (p) send('app:open-project', p);
  });
  app.on('open-file', (e, file) => {
    e.preventDefault();
    if (mainWindow) send('app:open-project', file);
    else pendingOpen = file;
  });
  pendingOpen = projectArg(process.argv) || null;

  app.whenReady().then(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true }); // restos de sesiones anteriores
    } catch {
      /* en uso por otra instancia */
    }
    registerProtocols();
    registerIpc();
    ai = setupAi({
      storage,
      userData,
      cacheDir,
      tempDir,
      srcDir: SRC,
      getWindow: () => mainWindow,
      allowWrite: (file) => allowedWrites.add(file),
      cacheKey,
      isTest: !!TEST_SCRIPT,
    });
    assistant = setupAssistant({ storage, getWindow: () => mainWindow });
    createMainWindow();
    // Detecta codificadores por hardware en segundo plano (la primera vez tarda unos segundos).
    setTimeout(() => getHw().catch(() => {}), 4000);
    app.on('activate', () => {
      if (!mainWindow) createMainWindow();
    });
  });

  app.on('window-all-closed', () => app.quit());
  app.on('will-quit', () => {
    if (exportJob) exportJob.ac.abort();
    ai?.shutdown();
  });
}

export { ffmpegPath };
