// Servidor MCP local: deja que las apps de IA del usuario (Claude Desktop, Gemini CLI…) usen LiteCut a través del
// puente src/mcp/litecut-mcp.cjs, que esas apps lanzan. Escucha solo en 127.0.0.1 y exige una clave aleatoria que
// cambia en cada inicio y se guarda en la carpeta de datos del usuario: nada queda expuesto a la red.
// No depende de Electron (se prueba con Node): las herramientas se ejecutan con callTool(), que conecta main.js.
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { AI_SERVER_NAME, AI_INSTRUCTIONS, AI_TOOL_MAP, mcpToolList } from '../shared/ai-tools.js';
import { writeFileAtomic } from './storage.js';

// Archivos que lee el puente: cómo conectarse (o cómo abrir LiteCut) y la lista de herramientas.
export const CONNECTION_FILE = 'ia-conexion.json';
export const TOOLS_FILE = 'ia-herramientas.json';
const HELLO_TIMEOUT = 5000;

export class AiServer {
  /**
   * dir: carpeta de datos del usuario. launch: { command, args } para que el puente abra LiteCut si está cerrado.
   * callTool(name, args, { progress, signal, client }) → { content: [...], isError? }
   */
  constructor({ dir, version, launch = null, callTool, onStatus = () => {} }) {
    this.dir = dir;
    this.version = version;
    this.launch = launch;
    this.callTool = callTool;
    this.onStatus = onStatus;
    this.enabled = false;
    this.server = null;
    this.port = 0;
    this.token = null;
    this.sessions = new Set();
    this.lastCall = null;
  }

  get running() {
    return !!this.server;
  }

  status() {
    return {
      enabled: this.enabled,
      running: this.running,
      clients: [...this.sessions].filter((s) => s.ready).map((s) => ({ name: s.client?.name || '', title: s.client?.title || '', version: s.client?.version || '', since: s.since })),
      lastCall: this.lastCall,
    };
  }

  emit() {
    this.onStatus(this.status());
  }

  async start() {
    if (this.server) return;
    const server = net.createServer((socket) => this.accept(socket));
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    server.on('error', () => {});
    this.server = server;
    this.port = server.address().port;
    this.token = crypto.randomBytes(32).toString('hex');
    this.writeFiles();
    this.emit();
  }

  async stop() {
    const server = this.server;
    this.closeAll();
    this.writeFiles();
    this.emit();
    if (server) await new Promise((resolve) => server.close(() => resolve()));
  }

  // Al salir de la app (síncrono): el puente sabrá que LiteCut está cerrado.
  shutdown() {
    this.closeAll();
    this.writeFiles({ quitting: true });
  }

  closeAll() {
    const server = this.server;
    this.server = null;
    this.port = 0;
    this.token = null;
    for (const s of this.sessions) s.socket.destroy();
    this.sessions.clear();
    if (server) server.close();
  }

  writeFiles({ quitting = false } = {}) {
    const info = { version: 1, app: 'LiteCut Studio', appVersion: this.version, pid: quitting ? null : process.pid, enabled: this.enabled, launch: this.launch };
    if (this.server) Object.assign(info, { host: '127.0.0.1', port: this.port, token: this.token });
    try {
      writeFileAtomic(path.join(this.dir, CONNECTION_FILE), JSON.stringify(info, null, 2));
      const tools = JSON.stringify({ appVersion: this.version, instructions: AI_INSTRUCTIONS, tools: mcpToolList() }, null, 1);
      const file = path.join(this.dir, TOOLS_FILE);
      const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
      if (old !== tools) writeFileAtomic(file, tools);
    } catch {
      /* carpeta de datos no disponible: el puente no podrá conectarse */
    }
  }

  checkToken(t) {
    if (typeof t !== 'string' || !this.token) return false;
    const a = Buffer.from(t);
    const b = Buffer.from(this.token);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  // Cada conexión empieza con una línea { token } (el saludo del puente); después todo es MCP (JSON por líneas).
  accept(socket) {
    socket.setNoDelay(true);
    socket.on('error', () => {});
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => socket.destroy(), HELLO_TIMEOUT);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const i = buf.indexOf(10);
      if (i < 0) {
        if (buf.length > 4096) socket.destroy();
        return;
      }
      socket.off('data', onData);
      socket.pause(); // lo que llegue antes de abrir la sesión MCP queda en espera
      clearTimeout(timer);
      let hello = null;
      try {
        hello = JSON.parse(buf.subarray(0, i).toString('utf8'));
      } catch {
        hello = null;
      }
      if (!hello || !this.checkToken(hello.token)) {
        socket.end(`${JSON.stringify({ litecut: 1, ok: false, error: 'Clave incorrecta: LiteCut se reinició o la configuración es de otra instalación.' })}\n`);
        return;
      }
      socket.write(`${JSON.stringify({ litecut: 1, ok: true, version: this.version })}\n`);
      this.openSession(socket, buf.subarray(i + 1)).catch(() => socket.destroy());
    };
    socket.on('data', onData);
  }

  async openSession(socket, rest) {
    const [{ Server }, types, stdio] = await Promise.all([
      import('@modelcontextprotocol/sdk/server'),
      import('@modelcontextprotocol/sdk/types.js'),
      import('@modelcontextprotocol/sdk/shared/stdio.js'),
    ]);
    if (socket.destroyed) return;
    const session = { socket, client: null, ready: false, since: Date.now() };
    this.sessions.add(session);
    const server = new Server({ name: AI_SERVER_NAME, title: 'LiteCut Studio', version: this.version }, { capabilities: { tools: {} }, instructions: AI_INSTRUCTIONS });
    server.setRequestHandler(types.ListToolsRequestSchema, async () => ({ tools: mcpToolList() }));
    server.setRequestHandler(types.CallToolRequestSchema, (req, extra) => this.runTool(req.params, extra, session));
    server.oninitialized = () => {
      session.client = server.getClientVersion() || null;
      session.ready = true;
      this.emit();
    };
    server.onclose = () => {
      if (this.sessions.delete(session)) this.emit();
    };
    const transport = new SocketTransport(socket, stdio);
    await server.connect(transport);
    if (rest.length) transport.receive(rest);
    socket.resume();
  }

  async runTool(params, extra, session) {
    const name = params.name;
    if (!AI_TOOL_MAP.has(name)) return { content: [{ type: 'text', text: `Herramienta desconocida: ${name}` }], isError: true };
    const token = extra._meta?.progressToken;
    let last = -Infinity;
    const progress =
      token === undefined
        ? null
        : (p) => {
            if (!(p.progress > last)) return; // el progreso solo puede aumentar
            last = p.progress;
            const params2 = { progressToken: token, progress: p.progress };
            if (p.total) params2.total = p.total;
            if (p.message) params2.message = p.message;
            extra.sendNotification({ method: 'notifications/progress', params: params2 }).catch(() => {});
          };
    this.lastCall = { name, client: session.client?.name || '', time: Date.now() };
    try {
      const res = await this.callTool(name, params.arguments || {}, { progress, signal: extra.signal, client: session.client });
      return normalizeResult(res);
    } catch (err) {
      return { content: [{ type: 'text', text: err?.message || String(err) }], isError: true };
    }
  }
}

function normalizeResult(res) {
  if (typeof res === 'string') return { content: [{ type: 'text', text: res }] };
  const content = (res?.content || []).filter((c) => c && (c.type === 'text' || c.type === 'image'));
  if (!content.length) content.push({ type: 'text', text: 'Hecho.' });
  return res?.isError ? { content, isError: true } : { content };
}

// Transporte MCP sobre el socket: mensajes JSON-RPC separados por saltos de línea (igual que stdio).
class SocketTransport {
  constructor(socket, { ReadBuffer, serializeMessage }) {
    this.socket = socket;
    this.serialize = serializeMessage;
    this.buffer = new ReadBuffer();
    this.closed = false;
  }

  async start() {
    this.socket.on('data', (d) => this.receive(d));
    this.socket.on('close', () => this.handleClose());
    this.socket.on('error', (e) => this.onerror?.(e));
  }

  receive(chunk) {
    try {
      this.buffer.append(chunk);
    } catch (err) {
      this.onerror?.(err);
      this.socket.destroy();
      return;
    }
    for (;;) {
      let msg;
      try {
        msg = this.buffer.readMessage();
      } catch (err) {
        this.onerror?.(err); // línea inválida: se descarta y se sigue
        continue;
      }
      if (!msg) break;
      this.onmessage?.(msg);
    }
  }

  send(message) {
    return new Promise((resolve) => {
      if (this.socket.destroyed) {
        resolve();
        return;
      }
      this.socket.write(this.serialize(message), () => resolve());
    });
  }

  async close() {
    this.socket.destroy();
    this.handleClose();
  }

  handleClose() {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.();
  }
}
