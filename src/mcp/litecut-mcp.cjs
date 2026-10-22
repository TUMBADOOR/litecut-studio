#!/usr/bin/env node
// Puente MCP por stdio de LiteCut Studio («litecut-mcp»).
// Las apps de IA (Claude Desktop, Gemini CLI…) lo lanzan y hablan MCP con él por la entrada y salida estándar.
// Por dentro se conecta al servidor MCP de LiteCut abierto (127.0.0.1 + la clave de ia-conexion.json, en la
// carpeta de datos del usuario) y le reenvía los mensajes. Si LiteCut está cerrado responde él mismo a la
// presentación y a la lista de herramientas, y abre LiteCut al usar la primera herramienta.
// Sin dependencias: se ejecuta con el propio LiteCut (ELECTRON_RUN_AS_NODE=1) o con Node 18 o superior.
//   Opciones: --dir <carpeta de datos de LiteCut>  --no-launch (no abrir LiteCut si está cerrado)
'use strict';
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const SUPPORTED_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const INIT_ID = 'litecut-puente-init';
const START_TIMEOUT = 90000;
const MSG_CLOSED = 'LiteCut Studio no está abierto y no se pudo abrir. Ábrelo y vuelve a intentarlo.';
const MSG_DISABLED = 'La conexión con IA está desactivada en LiteCut Studio. Actívala con el botón «IA» de la barra superior (Conectar con IA) y vuelve a intentarlo.';

const argv = process.argv.slice(2);
const option = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
};

function defaultDataDir() {
  const name = 'LiteCut Studio';
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), name);
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', name);
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), name);
}

const DATA_DIR = option('--dir') || process.env.LITECUT_USER_DATA || defaultDataDir();
const NO_LAUNCH = argv.includes('--no-launch') || process.env.LITECUT_MCP_NO_LAUNCH === '1';

const log = (text) => process.stderr.write(`[litecut-mcp] ${text}\n`);
const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};
const readInfo = () => readJson(path.join(DATA_DIR, 'ia-conexion.json'));
const alive = (pid) => {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
};

let clientInit = null; // parámetros del «initialize» de la app de IA
let protocolVersion = SUPPORTED_VERSIONS[1];
let link = null; // conexión con LiteCut: { socket, closed }
let linking = null; // { promise, launch }
const pending = new Map(); // id → método, peticiones reenviadas que esperan respuesta

// ---------- Herramientas cuando LiteCut está cerrado ----------
async function offlineCatalog() {
  const file = readJson(path.join(DATA_DIR, 'ia-herramientas.json'));
  if (file && Array.isArray(file.tools)) return file;
  try {
    // En desarrollo (o si LiteCut nunca se abrió con la conexión activada) se leen las definiciones del código.
    const mod = await import(pathToFileURL(path.join(__dirname, '..', 'shared', 'ai-tools.js')).href);
    return { tools: mod.mcpToolList(), instructions: mod.AI_INSTRUCTIONS };
  } catch {
    return { tools: [], instructions: '' };
  }
}

// ---------- Conexión con LiteCut ----------
function lineReader(onLine) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    let i;
    while ((i = buf.indexOf(10)) >= 0) {
      const line = buf.subarray(0, i).toString('utf8').replace(/\r$/, '');
      buf = buf.subarray(i + 1);
      if (line.trim()) onLine(line);
    }
  };
}

function openLink(info) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: info.host || '127.0.0.1', port: info.port });
    const state = { socket, closed: false, ready: false };
    const timer = setTimeout(() => fail(new Error('LiteCut Studio no respondió.')), 15000);
    let stage = 'hello';
    function fail(err) {
      clearTimeout(timer);
      if (stage === 'ready') return;
      stage = 'failed';
      socket.destroy();
      reject(err);
    }
    socket.setNoDelay(true);
    socket.on('connect', () => socket.write(`${JSON.stringify({ litecut: 1, token: info.token })}\n`));
    socket.on('error', (err) => fail(err));
    socket.on(
      'data',
      lineReader((line) => {
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          return;
        }
        if (stage === 'hello') {
          if (!msg.ok) return fail(new Error(msg.error || 'LiteCut rechazó la conexión.'));
          stage = 'init';
          const params = {
            protocolVersion,
            capabilities: clientInit?.capabilities || {},
            clientInfo: clientInit?.clientInfo || { name: 'litecut-mcp', version: '1' },
          };
          socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: INIT_ID, method: 'initialize', params })}\n`);
        } else if (stage === 'init') {
          if (msg.id !== INIT_ID) return;
          if (msg.error) return fail(new Error(msg.error.message || 'LiteCut rechazó la presentación.'));
          socket.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
          stage = 'ready';
          state.ready = true;
          clearTimeout(timer);
          resolve(state);
        } else {
          if (msg.id !== undefined && msg.method === undefined) pending.delete(msg.id);
          process.stdout.write(`${line}\n`);
        }
      })
    );
    socket.on('close', () => {
      state.closed = true;
      if (stage !== 'ready') return fail(new Error('LiteCut Studio cerró la conexión.'));
      if (link === state) link = null;
      // Lo que esperaba respuesta ya no la tendrá.
      for (const [id, method] of pending) {
        if (method === 'tools/call') toolError(id, 'LiteCut Studio se cerró mientras trabajaba. Vuelve a abrirlo e inténtalo de nuevo.');
        else send({ jsonrpc: '2.0', id, error: { code: -32000, message: 'LiteCut Studio se cerró.' } });
      }
      pending.clear();
    });
  });
}

function launchApp(info) {
  let command = info?.launch?.command;
  let args = info?.launch?.args || [];
  // Lanzado con el ejecutable de LiteCut (ELECTRON_RUN_AS_NODE): ese mismo ejecutable abre la app.
  if (!command && process.versions.electron && !/^electron(\.exe)?$/i.test(path.basename(process.execPath))) {
    command = process.execPath;
    args = [];
  }
  if (!command || !fs.existsSync(command)) throw new Error(MSG_CLOSED);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  log('abriendo LiteCut Studio…');
  const child = spawn(command, args, { detached: true, stdio: 'ignore', env });
  child.on('error', (err) => log(`no se pudo abrir LiteCut: ${err.message}`));
  child.unref();
}

async function connect(launch, onWait) {
  let info = readInfo();
  if (info?.enabled === false) throw new Error(MSG_DISABLED);
  let lastErr = null;
  if (info?.port && info.token && alive(info.pid)) {
    try {
      return await openLink(info);
    } catch (err) {
      lastErr = err;
    }
  }
  if (!launch || NO_LAUNCH) throw new Error(lastErr && alive(info?.pid) ? `No se pudo conectar con LiteCut Studio: ${lastErr.message}` : MSG_CLOSED);
  const previous = info?.token || null;
  if (!alive(info?.pid)) launchApp(info);
  const deadline = Date.now() + START_TIMEOUT;
  for (let n = 1; Date.now() < deadline; n++) {
    await sleep(700);
    if (n % 7 === 0) onWait?.(n);
    info = readInfo();
    if (info?.enabled === false && alive(info.pid)) throw new Error(MSG_DISABLED);
    const fresh = info?.token && info.token !== previous;
    if (info?.port && info.token && alive(info.pid) && (fresh || n % 5 === 0)) {
      try {
        return await openLink(info);
      } catch (err) {
        lastErr = err;
      }
    }
  }
  throw new Error('LiteCut Studio tardó demasiado en abrirse. Ábrelo a mano y vuelve a intentarlo.');
}

function ensureLink(launch, onWait) {
  if (link && !link.closed) return Promise.resolve(link);
  if (linking) return launch && !linking.launch ? linking.promise.catch(() => ensureLink(true, onWait)) : linking.promise;
  const promise = connect(launch, onWait)
    .then((l) => (link = l))
    .finally(() => {
      if (linking?.promise === promise) linking = null;
    });
  linking = { promise, launch };
  return promise;
}

// ---------- Mensajes de la app de IA ----------
function toolError(id, text) {
  send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError: true } });
}

function forward(msg, line) {
  if (msg.id !== undefined && msg.method) pending.set(msg.id, msg.method);
  link.socket.write(`${line}\n`);
}

async function onInitialize(msg) {
  clientInit = msg.params || {};
  const asked = clientInit.protocolVersion;
  protocolVersion = SUPPORTED_VERSIONS.includes(asked) ? asked : SUPPORTED_VERSIONS[0];
  const catalog = await offlineCatalog();
  send({
    jsonrpc: '2.0',
    id: msg.id,
    result: {
      protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'litecut-studio', title: 'LiteCut Studio', version: catalog.appVersion || '1' },
      instructions: catalog.instructions || '',
    },
  });
  // Si LiteCut ya está abierto, la conexión queda lista de antemano (sin abrirlo).
  ensureLink(false).catch(() => {});
}

function onMessage(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    log('mensaje inválido ignorado');
    return;
  }
  const isRequest = msg.method !== undefined && msg.id !== undefined;
  const ready = link && !link.closed;
  switch (msg.method) {
    case 'initialize':
      onInitialize(msg).catch((err) => send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: err.message } }));
      return;
    case 'notifications/initialized':
      return;
    case 'ping':
      if (isRequest) send({ jsonrpc: '2.0', id: msg.id, result: {} });
      return;
    case 'tools/list':
      if (ready) forward(msg, line);
      else offlineCatalog().then((c) => send({ jsonrpc: '2.0', id: msg.id, result: { tools: c.tools } }));
      return;
    case 'tools/call': {
      const token = msg.params?._meta?.progressToken;
      const onWait = (n) => {
        if (token !== undefined) send({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: token, progress: n, message: 'Abriendo LiteCut Studio…' } });
      };
      ensureLink(true, onWait).then(
        () => forward(msg, line),
        (err) => toolError(msg.id, err.message)
      );
      return;
    }
    default:
      if (ready) forward(msg, line);
      else if (linking && msg.method === 'notifications/cancelled') linking.promise.then(() => forward(msg, line), () => {});
      else if (isRequest) send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Método no disponible: ${msg.method}` } });
  }
}

process.stdin.on('data', lineReader(onMessage));
process.stdin.on('end', () => {
  link?.socket.end();
  setTimeout(() => process.exit(0), 200);
});
process.stdout.on('error', () => process.exit(0));
