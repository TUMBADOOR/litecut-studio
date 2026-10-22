// Pruebas de la conexión con asistentes de IA (sin interfaz): definiciones de las herramientas, validación,
// operaciones nuevas, análisis con FFmpeg y el circuito completo cliente MCP → puente (stdio) → servidor local.
// Uso: node scripts/test-ai.js [carpeta-de-trabajo]
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { AI_TOOLS, AI_TOOL_MAP, mcpToolList, validateArgs } from '../src/shared/ai-tools.js';
import { createProject, createClip, clipEnd, trackClips, mainTrack } from '../src/shared/model.js';
import * as ops from '../src/shared/ops.js';
import { runFfmpeg, lastLines, detectSilences, detectScenes, sampleFrames, grabFrame } from '../src/main/ffmpeg.js';
import { AiServer, CONNECTION_FILE, TOOLS_FILE } from '../src/main/ai-server.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BRIDGE = path.join(ROOT, 'src', 'mcp', 'litecut-mcp.cjs');
const dir = process.argv[2] || path.join(os.tmpdir(), 'litecut-test-ai');
fs.mkdirSync(dir, { recursive: true });

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${name}\n    ${err.stack || err.message}`);
  }
}
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

// ---------- Definiciones ----------
console.log('Herramientas:');
await test('nombres únicos y válidos, esquemas completos', () => {
  assert.equal(new Set(AI_TOOLS.map((t) => t.name)).size, AI_TOOLS.length);
  for (const t of AI_TOOLS) {
    assert.match(t.name, /^[a-z_]{3,64}$/, t.name);
    assert.ok(t.title && t.description.length > 30, `${t.name}: falta título o descripción`);
    assert.equal(t.inputSchema.type, 'object');
    for (const r of t.inputSchema.required || []) assert.ok(t.inputSchema.properties[r], `${t.name}: «${r}» obligatorio sin definir`);
    const walk = (s, where) => {
      assert.ok(['object', 'array', 'string', 'number', 'integer', 'boolean'].includes(s.type), `${where}: tipo ${s.type}`);
      for (const k of ['oneOf', 'anyOf', 'allOf', '$ref', 'additionalProperties']) assert.ok(!(k in s), `${where}: ${k} no es compatible con todos los modelos`);
      if (s.enum) assert.equal(s.type, 'string', `${where}: Gemini solo admite enum en textos`);
      if (s.properties) for (const [k, v] of Object.entries(s.properties)) walk(v, `${where}.${k}`);
      if (s.items) walk(s.items, `${where}[]`);
    };
    walk(t.inputSchema, t.name);
  }
  assert.equal(mcpToolList().length, AI_TOOLS.length);
  for (const n of ['ver_proyecto', 'importar_medios', 'dividir', 'recortar_clip', 'mover_clip', 'eliminar_clips', 'cambiar_velocidad', 'agregar_texto', 'poner_transicion', 'aplicar_filtro', 'ver_fotograma', 'exportar', 'detectar_silencios', 'detectar_escenas', 'fotogramas_de_muestra']) {
    assert.ok(AI_TOOL_MAP.has(n), `falta ${n}`);
  }
});

await test('validación de argumentos', () => {
  assert.throws(() => validateArgs('dividir', {}), /Falta el parámetro «tiempo»/);
  assert.deepEqual(validateArgs('dividir', { tiempo: '2.5', otro: 1 }), { tiempo: 2.5 });
  assert.throws(() => validateArgs('cambiar_velocidad', { clip: 'a', velocidad: 40 }), /como máximo 16/);
  assert.throws(() => validateArgs('poner_transicion', { clip: 'a', tipo: 'explosión' }), /debe ser uno de/);
  assert.throws(() => validateArgs('ver_fotograma', { ancho: 300.5 }), /entero/);
  assert.deepEqual(validateArgs('importar_medios', { rutas: 'C:\\a.mp4', agregar: 'true' }), { rutas: ['C:\\a.mp4'], agregar: true });
  assert.deepEqual(validateArgs('ajustar_clip', { clip: 'c', recorte: { izquierda: 0.1 } }), { clip: 'c', recorte: { izquierda: 0.1 } });
  assert.throws(() => validateArgs('no_existe', {}), /desconocida/);
});

// ---------- Operaciones ----------
function setup() {
  const p = createProject('16:9');
  p.media = [
    { id: 'v', kind: 'video', path: 'v.mp4', duration: 10, width: 1920, height: 1080, hasAudio: true },
    { id: 'i', kind: 'image', path: 'i.png', duration: 0, width: 800, height: 800 },
  ];
  return p;
}
const main = (p) => trackClips(p, mainTrack(p).id);

console.log('Operaciones:');
await test('recortar en la pista principal no deja huecos', () => {
  const p = setup();
  const a = ops.addMediaClip(p, p.media[0]);
  const b = ops.addMediaClip(p, p.media[0]);
  ops.trimClip(p, a.id, { head: 2, tail: 1 });
  ops.sanitizeProject(p);
  near(a.start, 0);
  near(a.in, 2);
  near(a.duration, 7);
  near(b.start, 7);
  ops.trimClip(p, a.id, { head: -1 }); // alargar hacia atrás recupera material de la fuente
  near(a.in, 1);
  near(b.start, 8);
});

await test('recortar fuera de la principal mueve el borde y no pisa al vecino', () => {
  const p = setup();
  const t = ops.addTrack(p, 'video');
  const x = createClip('image', { mediaId: 'i', trackId: t.id, start: 2, duration: 3 });
  const y = createClip('image', { mediaId: 'i', trackId: t.id, start: 6, duration: 3 });
  p.clips.push(x, y);
  ops.trimClip(p, x.id, { head: 1, tail: -5 });
  near(x.start, 3);
  near(clipEnd(x), 6); // se alarga solo hasta el siguiente clip
  ops.trimClip(p, y.id, { head: -10 });
  near(y.start, 6);
});

await test('eliminar un tramo dentro de un clip junta las partes', () => {
  const p = setup();
  const a = ops.addMediaClip(p, p.media[0]);
  const b = ops.addMediaClip(p, p.media[0]);
  const d = ops.removeRange(p, mainTrack(p).id, 3, 5);
  ops.sanitizeProject(p);
  near(d, 2);
  const l = main(p);
  assert.equal(l.length, 3);
  near(l[0].start, 0);
  near(l[0].duration, 3);
  near(l[1].start, 3);
  near(l[1].in, 5);
  near(l[1].duration, 5);
  near(b.start, 8);
  void a;
});

await test('eliminar un tramo que cruza dos clips y su audio separado', () => {
  const p = setup();
  const a = ops.addMediaClip(p, p.media[0]);
  const b = ops.addMediaClip(p, p.media[0]);
  const la = ops.detachAudio(p, a.id);
  ops.removeRange(p, mainTrack(p).id, 8, 12);
  ops.sanitizeProject(p);
  const [first, rest] = main(p);
  assert.equal(first, a);
  assert.ok(!p.clips.includes(b), 'la parte izquierda de b (10–12) se quitó');
  near(a.duration, 8);
  near(rest.start, 8);
  near(rest.in, 2);
  near(rest.duration, 8);
  near(la.duration, 8); // el audio separado sigue a su video
  assert.equal(p.clips.filter((c) => c.type === 'audio').length, 1);
  ops.removeRange(p, mainTrack(p).id, 0, 8); // quita el primer clip entero (y su audio)
  ops.sanitizeProject(p);
  assert.ok(!p.clips.includes(a) && !p.clips.includes(la));
  near(rest.start, 0);
});

await test('eliminar un tramo convierte en corte la transición que toca', () => {
  const p = setup();
  ops.addMediaClip(p, p.media[0]);
  const b = ops.addMediaClip(p, p.media[0]);
  ops.applyTransition(p, b.id, 'fade', 1);
  ops.removeRange(p, mainTrack(p).id, 9.2, 9.6);
  ops.sanitizeProject(p);
  const l = main(p);
  for (let i = 1; i < l.length; i++) assert.ok(l[i].start >= clipEnd(l[i - 1]) - 1e-6, 'sin solapes');
  near(Math.max(...l.map(clipEnd)), 19 - 0.4);
});

await test('tramos: de la fuente a la línea de tiempo, unir y restar', () => {
  const c = { start: 10, duration: 5, in: 2, speed: 2 }; // fuente 2–12
  const r = ops.sourceRangesToTimeline(c, [{ start: 0, end: 4 }, { start: 6, end: 8 }, { start: 11, end: 20 }], { margin: 0.1 });
  assert.equal(r.length, 3);
  near(r[0].start, 10); // empieza en silencio: sin margen al principio
  near(r[0].end, 10.9);
  near(r[1].start, 12.1);
  near(r[1].end, 12.9);
  near(r[2].start, 14.6);
  near(r[2].end, 15);
  assert.deepEqual(ops.mergeRanges([{ start: 3, end: 4 }, { start: 1, end: 2 }, { start: 1.5, end: 3 }]), [{ start: 1, end: 4 }]);
  assert.deepEqual(ops.subtractRanges([{ start: 0, end: 10 }], [{ start: 2, end: 3 }, { start: 9, end: 12 }]), [{ start: 0, end: 2 }, { start: 3, end: 9 }]);
});

// ---------- Análisis con FFmpeg ----------
console.log('Análisis con FFmpeg:');
const video = path.join(dir, 'escenas-y-silencio.mp4');
if (!fs.existsSync(video)) {
  const r = await runFfmpeg([
    '-hide_banner', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=25:d=6',
    '-f', 'lavfi', '-i', 'smptebars=s=640x360:r=25:d=6',
    '-f', 'lavfi', '-i', 'sine=f=440:d=3:sample_rate=44100',
    '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono:d=3',
    '-f', 'lavfi', '-i', 'sine=f=660:d=6:sample_rate=44100',
    '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v];[2:a][3:a][4:a]concat=n=3:v=0:a=1[a]',
    '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', video,
  ]);
  if (r.code !== 0) throw new Error(`No se pudo generar el video de prueba\n${lastLines(r.stderr)}`);
}

await test('silencedetect encuentra la pausa', async () => {
  const r = await detectSilences(video, { duration: 12 });
  assert.equal(r.complete, true);
  assert.equal(r.silences.length, 1, JSON.stringify(r.silences));
  near(r.silences[0].start, 3, 0.1);
  near(r.silences[0].end, 6, 0.1);
});

await test('silencedetect falla con claridad si no hay audio', async () => {
  await assert.rejects(() => detectSilences(path.join(ROOT, 'src', 'renderer', 'assets', 'icon.png')), /sonido/);
});

await test('scdet encuentra el cambio de escena (también en un tramo)', async () => {
  const r = await detectScenes(video, {});
  assert.equal(r.scenes.length, 1, JSON.stringify(r.scenes));
  near(r.scenes[0].time, 6, 0.1);
  const part = await detectScenes(video, { start: 4, duration: 4 });
  near(part.scenes[0].time, 6, 0.1);
  const none = await detectScenes(video, { start: 0, duration: 4 });
  assert.equal(none.scenes.length, 0);
});

await test('fotogramas de muestra (una pasada y solo clave) y fotograma suelto', async () => {
  const out = path.join(dir, 'muestras');
  fs.rmSync(out, { recursive: true, force: true });
  const list = await sampleFrames(video, out, { start: 0, end: 12, count: 4, width: 160 });
  assert.equal(list.length, 4);
  for (let i = 0; i < list.length; i++) {
    near(list[i].time, 1.5 + 3 * i, 0.2);
    const buf = fs.readFileSync(list[i].file);
    assert.ok(buf[0] === 0xff && buf[1] === 0xd8, 'JPEG');
  }
  const keys = await sampleFrames(video, path.join(dir, 'muestras-clave'), { start: 0, end: 12, count: 4, width: 160, keyframesOnly: true });
  assert.ok(keys.length >= 1);
  const png = await grabFrame(video, 8, { width: 160, format: 'png' });
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
});

// ---------- Servidor MCP local + puente ----------
console.log('Servidor MCP y puente:');
const dataDir = path.join(dir, 'datos');
fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true });
const calls = [];
const server = new AiServer({
  dir: dataDir,
  version: 'prueba',
  callTool: async (name, args, { progress }) => {
    calls.push({ name, args });
    if (name === 'exportar') {
      for (const v of [10, 50, 100]) {
        progress?.({ progress: v, total: 100, message: `${v} %` });
        await new Promise((r) => setTimeout(r, 30));
      }
      return { content: [{ type: 'text', text: 'Exportación terminada' }] };
    }
    if (name === 'ver_fotograma') return { content: [{ type: 'image', data: Buffer.from('imagen').toString('base64'), mimeType: 'image/png' }] };
    if (name === 'dividir') throw new Error('No hay ningún clip');
    return { content: [{ type: 'text', text: `ok ${name}` }] };
  },
});
server.enabled = true;

function bridgeClient() {
  const transport = new StdioClientTransport({ command: process.execPath, args: [BRIDGE, '--dir', dataDir, '--no-launch'], stderr: 'pipe' });
  const client = new Client({ name: 'cliente-de-prueba', version: '1.0.0' });
  return { client, transport };
}

await test('sin LiteCut abierto, el puente responde la presentación y la lista de herramientas', async () => {
  const { client, transport } = bridgeClient();
  await client.connect(transport);
  try {
    assert.equal(client.getServerVersion().name, 'litecut-studio');
    assert.match(client.getInstructions() || '', /LiteCut/);
    const { tools } = await client.listTools();
    assert.equal(tools.length, AI_TOOLS.length);
    const r = await client.callTool({ name: 'ver_proyecto', arguments: {} });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /no está abierto/);
  } finally {
    await client.close();
  }
});

await server.start();
const info = JSON.parse(fs.readFileSync(path.join(dataDir, CONNECTION_FILE), 'utf8'));
const toolsFile = JSON.parse(fs.readFileSync(path.join(dataDir, TOOLS_FILE), 'utf8'));

await test('archivos de conexión: solo 127.0.0.1, clave aleatoria y lista de herramientas', () => {
  assert.equal(info.host, '127.0.0.1');
  assert.ok(info.port > 0 && /^[0-9a-f]{64}$/.test(info.token));
  assert.equal(info.enabled, true);
  assert.equal(toolsFile.tools.length, AI_TOOLS.length);
  assert.equal(server.server.address().address, '127.0.0.1');
});

await test('una clave incorrecta se rechaza', async () => {
  const reply = await new Promise((resolve, reject) => {
    const s = net.connect({ host: '127.0.0.1', port: info.port }, () => s.write(`${JSON.stringify({ litecut: 1, token: 'f'.repeat(64) })}\n`));
    let buf = '';
    s.on('data', (d) => (buf += d));
    s.on('close', () => resolve(buf));
    s.on('error', reject);
  });
  assert.equal(JSON.parse(reply).ok, false);
});

await test('cliente MCP → puente → servidor: herramientas, progreso, imágenes y errores', async () => {
  const { client, transport } = bridgeClient();
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    assert.equal(tools.length, AI_TOOLS.length);
    const r1 = await client.callTool({ name: 'ver_proyecto', arguments: {} });
    assert.equal(r1.content[0].text, 'ok ver_proyecto');
    const progress = [];
    const r2 = await client.callTool({ name: 'exportar', arguments: { formato: 'mp4' } }, undefined, { onprogress: (p) => progress.push(p.progress) });
    assert.equal(r2.content[0].text, 'Exportación terminada');
    assert.deepEqual(progress, [10, 50, 100]);
    const r3 = await client.callTool({ name: 'ver_fotograma', arguments: { tiempo: 1 } });
    assert.equal(r3.content[0].type, 'image');
    const r4 = await client.callTool({ name: 'dividir', arguments: { tiempo: 1 } });
    assert.equal(r4.isError, true);
    assert.match(r4.content[0].text, /No hay ningún clip/);
    assert.deepEqual(calls.map((c) => c.name), ['ver_proyecto', 'exportar', 'ver_fotograma', 'dividir']);
    assert.equal(server.status().clients[0]?.name, 'cliente-de-prueba');
    // LiteCut se cierra y se vuelve a abrir (con otra clave): el puente se reconecta solo.
    await server.stop();
    const off = await client.callTool({ name: 'ver_proyecto', arguments: {} });
    assert.equal(off.isError, true);
    await server.start();
    const again = await client.callTool({ name: 'ver_proyecto', arguments: {} });
    assert.equal(again.content[0].text, 'ok ver_proyecto');
  } finally {
    await client.close();
  }
});

await test('con la conexión desactivada, el puente lo explica', async () => {
  server.enabled = false;
  await server.stop();
  const { client, transport } = bridgeClient();
  await client.connect(transport);
  try {
    const r = await client.callTool({ name: 'ver_proyecto', arguments: {} });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /desactivada/);
  } finally {
    await client.close();
  }
});

console.log(failed ? `\n${failed} prueba(s) fallaron` : `\n${passed} pruebas correctas`);
process.exit(failed ? 1 : 0);
