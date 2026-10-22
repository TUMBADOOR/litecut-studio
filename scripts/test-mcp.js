// Prueba de punta a punta de la conexión con IA: abre LiteCut en modo de prueba (con su propia carpeta de datos,
// sin tocar el autoguardado del usuario), se conecta como lo haría Claude Desktop (cliente MCP → puente por stdio)
// y edita un video: importar, cortar silencios, dividir, poner un título en 9:16, ver un fotograma y exportar.
// Deja capturas de pantalla de la app en la carpeta de salida.
// Uso: node scripts/test-mcp.js [carpeta-de-trabajo]
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import electronPath from 'electron';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { runFfmpeg, probe, lastLines } from '../src/main/ffmpeg.js';
import { AI_TOOLS } from '../src/shared/ai-tools.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BRIDGE = path.join(ROOT, 'src', 'mcp', 'litecut-mcp.cjs');
const base = process.argv[2] || path.join(os.tmpdir(), 'litecut-test-mcp');
const userData = path.join(base, 'datos');
const out = path.join(base, 'salida');
fs.rmSync(userData, { recursive: true, force: true });
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(userData, { recursive: true });
fs.mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Video de prueba: 12 s, cambio de escena a los 6 s y una pausa de sonido de 3 a 6 s.
const video = path.join(base, 'clase.mp4');
if (!fs.existsSync(video)) {
  const r = await runFfmpeg([
    '-hide_banner', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=30:d=6',
    '-f', 'lavfi', '-i', 'smptebars=s=1280x720:r=30:d=6',
    '-f', 'lavfi', '-i', 'sine=f=440:d=3:sample_rate=44100',
    '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono:d=3',
    '-f', 'lavfi', '-i', 'sine=f=660:d=6:sample_rate=44100',
    '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v];[2:a][3:a][4:a]concat=n=3:v=0:a=1[a]',
    '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', video,
  ]);
  if (r.code !== 0) throw new Error(`No se pudo generar el video de prueba\n${lastLines(r.stderr)}`);
}

// Guion que corre dentro de la app: guarda una captura después de cada herramienta y cierra al terminar.
const rendererScript = path.join(base, 'guion-app.js');
fs.writeFileSync(
  rendererScript,
  `(async () => {
  const api = window.api;
  let n = 0;
  let saved = false;
  window.addEventListener('litecut:ai', async (e) => {
    const { name, ok } = e.detail;
    const k = ++n;
    await api.test.log(\`IA \${k} \${name} \${ok ? 'ok' : 'error'}\`);
    await new Promise((r) => setTimeout(r, 350));
    await api.test.capture(\`ia-\${String(k).padStart(2, '0')}-\${name}\`);
    if (name === 'guardar_proyecto') saved = true;
    else if (saved && name === 'ver_proyecto') setTimeout(() => api.test.done(0), 1200);
  });
  setTimeout(() => api.test.done(3), 10 * 60 * 1000);
  await api.test.log('guion listo');
})();`
);

const testEnv = (script) => ({ ...process.env, LITECUT_TEST: script, LITECUT_USER_DATA: userData, LITECUT_TEST_OUT: out, LITECUT_RECORDINGS_DIR: path.join(base, 'grabaciones'), LITECUT_AI: '1' });
const infoFile = path.join(userData, 'ia-conexion.json');
const readInfo = () => (fs.existsSync(infoFile) ? JSON.parse(fs.readFileSync(infoFile, 'utf8')) : {});

console.log('Abriendo LiteCut en modo de prueba…');
const app = spawn(electronPath, [ROOT], { env: testEnv(rendererScript), stdio: 'ignore' });
const exited = new Promise((r) => app.on('exit', (code) => r(code)));

let failures = 0;
const step = async (name, fn) => {
  const t0 = Date.now();
  try {
    const r = await fn();
    console.log(`  ✓ ${name} (${((Date.now() - t0) / 1000).toFixed(1)} s)${r ? ` — ${r}` : ''}`);
  } catch (err) {
    failures++;
    console.log(`  ✗ ${name}\n    ${err.stack || err.message}`);
  }
};
const text = (r) => r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
const json = (r) => JSON.parse(text(r).split('\n').slice(1).join('\n'));
const pngSize = (b64) => {
  const b = Buffer.from(b64, 'base64');
  assert.equal(b.subarray(1, 4).toString(), 'PNG');
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
};

let client;
try {
  // LiteCut publica la conexión cuando la interfaz está lista.
  for (let i = 0; i < 120 && !readInfo().port; i++) await sleep(500);
  client = new Client({ name: 'prueba-litecut', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [BRIDGE, '--dir', userData, '--no-launch'], stderr: 'inherit' }));
  const call = async (name, args = {}, opts = {}) => {
    const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 120000, ...opts });
    if (r.isError) throw new Error(`${name}: ${text(r)}`);
    return r;
  };
  let mediaId;
  let clipId;

  console.log('Herramientas desde un cliente MCP:');
  await step('lista de herramientas', async () => {
    const { tools } = await client.listTools();
    assert.equal(tools.length, AI_TOOLS.length);
    return `${tools.length} herramientas`;
  });
  await step('importar y añadir el video', async () => {
    const d = json(await call('importar_medios', { rutas: [video], agregar: true }));
    assert.equal(d.medios.length, 1);
    assert.equal(d.clips.length, 1);
    mediaId = d.medios[0].id;
    clipId = d.clips[0].id;
    return `${d.medios[0].nombre} ${d.medios[0].duracion} s`;
  });
  await step('detectar silencios', async () => {
    const d = json(await call('detectar_silencios'));
    assert.equal(d.silencios.length, 1);
    assert.ok(Math.abs(d.silencios[0].inicio - 3) < 0.15 && Math.abs(d.silencios[0].fin - 6) < 0.15, JSON.stringify(d.silencios));
    return `pausa ${d.silencios[0].inicio}–${d.silencios[0].fin} s`;
  });
  await step('cortar silencios (un paso de deshacer)', async () => {
    const d = json(await call('cortar_silencios', { margen: 0.1 }));
    assert.equal(d.cortes, 1);
    assert.ok(Math.abs(d.duracion_ahora - 9.2) < 0.2, `duración ${d.duracion_ahora}`);
    return `${d.duracion_antes} s → ${d.duracion_ahora} s`;
  });
  await step('detectar escenas', async () => {
    const d = json(await call('detectar_escenas', { medio: mediaId }));
    assert.equal(d.escenas.length, 1);
    assert.ok(Math.abs(d.escenas[0].tiempo_archivo - 6) < 0.15);
    return `cambio a los ${d.escenas[0].tiempo_archivo} s del archivo`;
  });
  await step('dividir', async () => {
    const d = json(await call('dividir', { tiempo: 1.5 }));
    assert.equal(d.partes_nuevas.length, 1);
    return `nueva parte ${d.partes_nuevas[0].id}`;
  });
  await step('pasar a 9:16 con fondo desenfocado', async () => {
    await call('configurar_proyecto', { formato: '9:16', relleno: 'desenfoque', nombre: 'Clase 1' });
    const d = json(await call('ver_proyecto'));
    assert.equal(d.lienzo.ancho, 1080);
    assert.equal(d.lienzo.alto, 1920);
    assert.ok(d.clips.filter((c) => c.pista === 'V1').every((c) => c.fondo === 'desenfoque'));
  });
  await step('añadir un título', async () => {
    const d = json(await call('agregar_texto', { texto: 'Clase 1: cortes automáticos', estilo: 'title', inicio: 0, duracion: 3, posicion: 'arriba' }));
    assert.equal(d.tipo, 'text');
    assert.equal(d.pista, 'V2');
    return `${d.texto} (${d.inicio}–${d.fin} s)`;
  });
  await step('deshacer y rehacer el título', async () => {
    await call('deshacer');
    assert.ok(!json(await call('ver_proyecto')).clips.some((c) => c.tipo === 'text'));
    await call('rehacer');
    assert.ok(json(await call('ver_proyecto')).clips.some((c) => c.tipo === 'text'));
  });
  await step('ver un fotograma (PNG pequeño)', async () => {
    const r = await call('ver_fotograma', { tiempo: 1, ancho: 360 });
    const img = r.content.find((c) => c.type === 'image');
    const { w, h } = pngSize(img.data);
    fs.writeFileSync(path.join(out, 'fotograma-ia.png'), Buffer.from(img.data, 'base64'));
    assert.equal(w, 360);
    assert.equal(h, 640);
    assert.ok(!/preparando/.test(text(r)), text(r));
    return `${w}×${h}, ${Math.round(img.data.length * 0.75 / 1024)} KB`;
  });
  await step('fotogramas de muestra del video', async () => {
    const r = await call('fotogramas_de_muestra', { medio: mediaId, cantidad: 3, ancho: 240 });
    assert.equal(r.content.filter((c) => c.type === 'image').length, 3);
  });
  let output = null;
  await step('exportar con progreso', async () => {
    const progress = [];
    const target = path.join(out, 'clase-1.mp4');
    let r = await call('exportar', { ruta: target, resolucion: '360p', esperar: 55 }, { onprogress: (p) => progress.push(p.progress), resetTimeoutOnProgress: true });
    while (/en curso/.test(text(r))) r = await call('estado_exportacion', { esperar: 55 }, { onprogress: (p) => progress.push(p.progress) });
    assert.match(text(r), /terminada/);
    output = json(r).archivo;
    assert.equal(output, target);
    assert.ok(progress.length > 0, 'sin notificaciones de progreso');
    return `${progress.length} avisos de progreso`;
  });
  await step('el video exportado es correcto', async () => {
    const info = await probe(output);
    assert.equal(info.width, 360);
    assert.equal(info.height, 640);
    assert.ok(info.hasAudio);
    assert.ok(Math.abs(info.duration - 9.2) < 0.3, `duración ${info.duration}`);
    return `${info.width}×${info.height}, ${info.duration.toFixed(2)} s`;
  });
  await step('no sobrescribe sin permiso', async () => {
    const r = await client.callTool({ name: 'exportar', arguments: { ruta: output, resolucion: '360p' } });
    assert.equal(r.isError, true);
    assert.match(text(r), /Ya existe/);
  });
  await step('guardar el proyecto', async () => {
    const file = path.join(out, 'clase-1.lcproj');
    await call('guardar_proyecto', { ruta: file });
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(saved.settings.aspect, '9:16');
    assert.ok(saved.clips.some((c) => c.type === 'text'));
    void clipId;
  });
  await step('estado final', async () => {
    const d = json(await call('ver_proyecto'));
    assert.equal(d.guardado, true);
    return `${d.clips.length} clips, ${d.duracion} s`;
  });
} catch (err) {
  failures++;
  console.log(`  ✗ ${err.stack || err.message}`);
} finally {
  await client?.close().catch(() => {});
  const code = await Promise.race([exited, sleep(30000).then(() => 'tiempo agotado')]);
  if (code === 'tiempo agotado') app.kill();
  console.log(`LiteCut se cerró (${code}).`);
}

// Con LiteCut cerrado, el puente lo abre al usar la primera herramienta (aquí, en modo de prueba).
console.log('El puente abre LiteCut si está cerrado:');
await step('abrir LiteCut desde el puente y usar una herramienta', async () => {
  const info = readInfo();
  assert.equal(info.pid, null, 'LiteCut debería figurar como cerrado');
  assert.ok(info.launch?.command, 'falta cómo abrir LiteCut');
  const script = path.join(base, 'guion-app-2.js');
  fs.writeFileSync(script, `window.addEventListener('litecut:ai', () => setTimeout(() => window.api.test.done(0), 800)); setTimeout(() => window.api.test.done(3), 120000);`);
  const c2 = new Client({ name: 'prueba-arranque', version: '1.0.0' });
  await c2.connect(new StdioClientTransport({ command: process.execPath, args: [BRIDGE, '--dir', userData], env: testEnv(script), stderr: 'inherit' }));
  try {
    const t0 = Date.now();
    const r = await c2.callTool({ name: 'ver_proyecto', arguments: {} }, undefined, { timeout: 120000 });
    assert.ok(!r.isError, text(r));
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    // La primera llamada puede llegar antes de que el guion de la app escuche: se repite hasta que la app se cierra
    // (comprobándolo antes de cada llamada, para que el puente no la vuelva a abrir).
    for (let i = 0; i < 20; i++) {
      await sleep(1500);
      if (!readInfo().pid) break;
      await c2.callTool({ name: 'ver_proyecto', arguments: {} }).catch(() => {});
    }
    assert.equal(readInfo().pid, null, 'LiteCut no se cerró');
    return `abierto y conectado en ${secs} s`;
  } finally {
    await c2.close();
  }
});
console.log(`Capturas y archivos en ${out}`);
console.log(failures ? `\n${failures} paso(s) fallaron` : '\nPrueba de punta a punta correcta');
process.exit(failures ? 1 : 0);
