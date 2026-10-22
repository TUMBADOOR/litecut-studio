// Prueba de punta a punta del asistente integrado: abre LiteCut en modo de prueba (con su propia carpeta de datos,
// sin tocar la del usuario) junto a un servidor local que imita la API de OpenAI. Desde la interfaz se configura el
// asistente (proveedor, modelo, dirección y clave), se prueba la conexión y se le pide importar un video, cortar los
// silencios, poner un título y exportar. Después se comprueban Ctrl+Z, el botón «Deshacer» y el botón «Detener».
// Deja capturas de pantalla en la carpeta de salida.
// Uso: node scripts/test-assistant-app.js [carpeta-de-trabajo]
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import electronPath from 'electron';
import { runFfmpeg, probe, lastLines } from '../src/main/ffmpeg.js';
import { AI_TOOLS } from '../src/shared/ai-tools.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = process.argv[2] || path.join(os.tmpdir(), 'litecut-test-asistente');
const userData = path.join(base, 'datos');
const out = path.join(base, 'salida');
fs.rmSync(userData, { recursive: true, force: true });
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(userData, { recursive: true });
fs.mkdirSync(out, { recursive: true });
const KEY = 'sk-prueba-litecut';
const HINT = KEY.slice(-4); // lo único de la clave que la interfaz llega a ver
const MODEL = 'modelo-de-prueba';
const exported = path.join(out, 'asistente.mp4');

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

// ---------- Proveedor simulado (API de OpenAI, Chat Completions) ----------
// Responde según el último mensaje: a un pedido del usuario, con llamadas a herramientas; a los resultados, con la
// siguiente herramienta del guion. Comprueba en cada paso el formato que recibe.
const problems = [];
const requests = [];
const stopTest = { aborted: false };
let rateLimited = false;
const expect = (cond, msg) => cond || problems.push(msg);

function chatReply(body) {
  const msgs = body.messages;
  const lastMsg = msgs[msgs.length - 1];
  const text = (t) => ({ choices: [{ message: { role: 'assistant', content: t }, finish_reason: 'stop' }], usage: { prompt_tokens: 1200, completion_tokens: 30 } });
  let n = 0;
  const calls = (...list) => ({
    choices: [{ message: { role: 'assistant', content: null, tool_calls: list.map(([name, args]) => ({ id: `call_${requests.length}_${++n}`, type: 'function', function: { name, arguments: JSON.stringify(args) } })) }, finish_reason: 'tool_calls' }],
    usage: { prompt_tokens: 1500, completion_tokens: 20 },
  });
  if (lastMsg.role === 'user' && typeof lastMsg.content === 'string') {
    if (/Prueba de conexión/.test(lastMsg.content)) return text('OK');
    if (/corta los silencios/.test(lastMsg.content)) {
      expect(msgs[0].role === 'system' && /LiteCut/.test(msgs[0].content), 'falta el mensaje de sistema');
      expect(body.tools?.length === AI_TOOLS.length && body.tools.every((t) => t.type === 'function' && t.function.parameters?.type === 'object'), 'lista de herramientas incorrecta');
      expect(body.tool_choice === 'auto', 'tool_choice');
      return calls(['ver_proyecto', {}], ['importar_medios', { rutas: [video], agregar: true }]);
    }
    if (/prueba detener/.test(lastMsg.content)) return 'esperar';
    if (/gracias/.test(lastMsg.content)) return text('¡De nada!');
    problems.push(`mensaje inesperado: ${lastMsg.content}`);
    return text('FALLO');
  }
  // Resultados de herramientas: cada llamada del último mensaje de la IA debe tener su resultado.
  const asst = [...msgs].reverse().find((m) => m.role === 'assistant');
  const after = msgs.slice(msgs.indexOf(asst) + 1);
  const results = asst.tool_calls.map((tc) => after.find((m) => m.role === 'tool' && m.tool_call_id === tc.id)?.content);
  expect(results.every((r) => typeof r === 'string' && r.length), `faltan resultados de ${asst.tool_calls.map((t) => t.function.name)}`);
  const names = asst.tool_calls.map((t) => t.function.name).join(',');
  switch (names) {
    case 'ver_proyecto,importar_medios':
      if (!rateLimited) {
        rateLimited = true;
        return 'limite'; // una vez: «espera 1 s» (como el nivel gratuito por minuto)
      }
      expect(/Importado\(s\) 1 archivo/.test(results[1]), `importar: ${results[1]}`);
      return calls(['cortar_silencios', { margen: 0.1 }]);
    case 'cortar_silencios':
      expect(/Cortadas 1 pausa/.test(results[0]), `cortar silencios: ${results[0]}`);
      return calls(['agregar_texto', { texto: 'Mi primer video', estilo: 'title', inicio: 0, duracion: 3, posicion: 'arriba' }]);
    case 'agregar_texto':
      expect(/Texto añadido/.test(results[0]), `texto: ${results[0]}`);
      return calls(['ver_fotograma', { tiempo: 1, ancho: 320, formato: 'jpeg' }]);
    case 'ver_fotograma': {
      const img = after.find((m) => m.role === 'user' && Array.isArray(m.content))?.content.find((c) => c.type === 'image_url');
      expect(/^data:image\/jpeg;base64,\/9j\//.test(img?.image_url?.url || ''), 'la imagen de ver_fotograma no llegó como image_url JPEG');
      return calls(['exportar', { ruta: exported, resolucion: '360p', esperar: 55 }]);
    }
    case 'exportar':
    case 'estado_exportacion':
      if (/en curso/.test(results[0])) return calls(['estado_exportacion', { esperar: 55 }]);
      expect(/terminada/.test(results[0]), `exportar: ${results[0]}`);
      return text('Listo: importé el video, **corté los silencios**, puse el título y lo exporté en 360p.');
    default:
      problems.push(`llamadas inesperadas: ${names}`);
      return text('FALLO');
  }
}

const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (d) => (raw += d));
  req.on('end', () => {
    const send = (status, data, headers = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(data));
    };
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') return send(404, { error: { message: `ruta desconocida ${req.url}` } });
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      problems.push('cuerpo que no es JSON');
      return send(400, { error: { message: 'JSON inválido' } });
    }
    requests.push({ time: Date.now(), messages: body.messages.length, last: body.messages[body.messages.length - 1]?.role });
    if (req.headers.authorization !== `Bearer ${KEY}`) {
      problems.push(`clave incorrecta: ${req.headers.authorization}`);
      return send(401, { error: { message: 'Incorrect API key provided', type: 'invalid_request_error' } });
    }
    expect(body.model === MODEL, `modelo ${body.model}`);
    const reply = chatReply(body);
    if (reply === 'limite') return send(429, { error: { message: 'Rate limit reached for requests', type: 'requests', code: 'rate_limit_exceeded' } }, { 'retry-after': '1' });
    if (reply === 'esperar') {
      res.on('close', () => {
        if (!res.writableEnded) stopTest.aborted = true;
      });
      setTimeout(() => !res.writableEnded && !res.destroyed && send(200, { choices: [{ message: { role: 'assistant', content: 'tarde' }, finish_reason: 'stop' }] }), 15000);
      return undefined;
    }
    return send(200, reply);
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const apiBase = `http://127.0.0.1:${server.address().port}/v1`;

// ---------- Guion que corre dentro de la app ----------
const rendererScript = path.join(base, 'guion-asistente.js');
fs.writeFileSync(
  rendererScript,
  `(async () => {
  const api = window.api;
  const VIDEO = ${JSON.stringify(video)};
  const EXPORTED = ${JSON.stringify(exported)};
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const fails = [];
  const check = async (cond, name) => {
    await api.test.log(\`\${cond ? 'OK' : 'FALLO'} \${name}\`);
    if (!cond) fails.push(name);
  };
  const waitFor = async (fn, what, ms = 20000) => {
    const t0 = Date.now();
    for (;;) {
      const v = fn();
      if (v) return v;
      if (Date.now() - t0 > ms) throw new Error('tiempo agotado esperando ' + what);
      await sleep(100);
    }
  };
  const nextEnd = (ms = 240000) => new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('el asistente no terminó')), ms);
    window.addEventListener('litecut:assistant', function h(e) {
      if (e.detail.state !== 'end') return;
      window.removeEventListener('litecut:assistant', h);
      clearTimeout(t);
      resolve(e.detail);
    });
  });
  const button = (root, text) => [...root.querySelectorAll('button')].find((b) => b.textContent.trim() === text);
  const setValue = async (el, value) => {
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(250);
  };
  const ask = async (text) => {
    const input = document.querySelector('.asst-input');
    input.focus();
    input.value = text;
    input.dispatchEvent(new Event('input'));
    const ended = nextEnd();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    return ended;
  };
  setTimeout(() => api.test.done(3), 6 * 60 * 1000);
  try {
    const { store } = window.__app;
    // 1. Pestaña Asistente sin configurar.
    document.querySelector('[data-tab="assistant"]').click();
    await waitFor(() => document.querySelector('.asst-input'), 'el panel del asistente');
    await sleep(400);
    await check(!!button(document.querySelector('.asst'), 'Configurar el asistente'), 'sin clave, el panel invita a configurarlo');
    await api.test.capture('01-sin-configurar');

    // 2. Ajustes: OpenAI con dirección propia (el proveedor simulado), modelo y clave; probar la conexión.
    document.querySelector('.asst-head .ibtn[title="Ajustes del asistente"]').click();
    const dlg = await waitFor(() => document.querySelector('.asst-modal'), 'los ajustes');
    await check(/nivel gratuito/.test(dlg.textContent) && /Qué se envía a Google Gemini/.test(dlg.textContent), 'Gemini por defecto, con el aviso de datos');
    button(dlg, 'OpenAI').click();
    await sleep(400);
    await setValue(dlg.querySelector('input[list="asst-models-openai"]'), ${JSON.stringify(MODEL)});
    dlg.querySelector('details.asst-adv').open = true;
    await setValue(dlg.querySelector('details.asst-adv input'), ${JSON.stringify(apiBase)});
    // La clave se pega y se prueba sin pulsar «Guardar»: se guarda sola antes de probar.
    dlg.querySelector('input[type="password"]').value = '  ${KEY} ';
    button(dlg, 'Probar conexión').click();
    const msg = await waitFor(() => dlg.querySelector('.asst-test-msg.ok, .asst-test-msg.err'), 'la prueba de conexión');
    await check(msg.classList.contains('ok'), 'probar conexión: ' + msg.textContent);
    await check(/Guardada ····${HINT}/.test(dlg.textContent), 'la clave quedó guardada al probar');
    const cfg = await api.assistant.config();
    await check(cfg.provider === 'openai' && cfg.models.openai === ${JSON.stringify(MODEL)} && cfg.urls.openai === ${JSON.stringify(apiBase)}, 'proveedor, modelo y dirección guardados');
    await check(cfg.keys.openai.saved && cfg.keys.openai.hint === ${JSON.stringify(HINT)} && cfg.encryption && !JSON.stringify(cfg).includes(${JSON.stringify(KEY)}), 'la clave se guarda cifrada y no vuelve a la interfaz');
    await api.test.capture('02-ajustes');
    button(dlg.closest('.modal'), 'Listo').click();
    await sleep(500);
    await check(/OpenAI · ${MODEL}/.test(document.querySelector('.asst-chip').textContent), 'el panel muestra proveedor y modelo');
    await check(document.querySelectorAll('.asst-example').length > 0, 'con clave, el panel ofrece ejemplos');
    await api.test.capture('03-configurado');

    // 3. El pedido completo.
    const r1 = await ask('Importa ' + VIDEO + ', corta los silencios, pon el título «Mi primer video» y exporta en 360p.');
    await check(r1.outcome === 'done', 'el asistente terminó (' + r1.outcome + ', ' + r1.steps + ' pasos)');
    const texts = store.project.clips.filter((c) => c.type === 'text');
    await check(texts.length === 1 && texts[0].text.content === 'Mi primer video', 'el título está en el proyecto');
    await check(store.project.clips.filter((c) => c.type === 'video').length === 2, 'el video quedó en dos partes (sin la pausa)');
    const rows = [...document.querySelectorAll('.asst-tool')];
    const titles = rows.map((r) => r.querySelector('b').textContent);
    await check(['Ver proyecto', 'Importar medios', 'Cortar silencios', 'Añadir texto', 'Ver fotograma', 'Exportar'].every((t) => titles.includes(t)), 'el chat muestra cada herramienta: ' + titles.join(', '));
    await check(rows.every((r) => !r.classList.contains('err') && !r.classList.contains('run')), 'todas las herramientas terminaron bien');
    await check(!!document.querySelector('.asst-tool[data-tool="ver_fotograma"] img'), 'el chat muestra la imagen que vio la IA');
    await check(/corté los silencios/.test([...document.querySelectorAll('.asst-msg.ai')].pop()?.textContent || ''), 'la respuesta final está en el chat');
    const log = document.querySelector('.asst-log');
    await sleep(300);
    await check(log.scrollHeight - log.scrollTop - log.clientHeight < 40, 'el chat quedó desplazado hasta el final');
    await check(/≈ [\\d.]+ tokens/.test(document.querySelector('.asst-tokens').textContent), 'cuenta de tokens');
    await check((await api.fs.exists([EXPORTED]))[0], 'el video se exportó');
    await sleep(300);
    await api.test.capture('04-terminado');

    // 4. Ctrl+Z con el foco en el chat vacío deshace lo último que hizo la IA (el título); Ctrl+Y lo rehace.
    document.querySelector('.asst-input').focus();
    await api.test.menu('undo');
    await sleep(300);
    await check(!store.project.clips.some((c) => c.type === 'text'), 'Ctrl+Z quitó el título');
    await api.test.menu('redo');
    await sleep(300);
    await check(store.project.clips.some((c) => c.type === 'text'), 'Ctrl+Y lo devolvió');
    // 5. «Deshacer los 3»: todo lo que cambió la IA en ese pedido.
    const undoBtn = [...document.querySelectorAll('.asst-undo button')].pop();
    await check(/Deshacer los 3/.test(undoBtn?.textContent || ''), 'botón para deshacer los 3 cambios del pedido');
    undoBtn.click();
    await sleep(300);
    await check(store.project.clips.length === 0, 'el botón deshizo los cambios de la IA');
    await api.test.capture('05-deshecho');

    // 6. Detener mientras la IA piensa; la conversación sigue después.
    const ended = ask('prueba detener');
    await waitFor(() => document.querySelector('.asst.running'), 'que empiece a trabajar');
    await sleep(700);
    const t0 = Date.now();
    button(document.querySelector('.asst-status'), 'Detener').click();
    const r2 = await ended;
    await check(r2.outcome === 'stopped' && Date.now() - t0 < 3000, 'Detener corta la espera (' + (Date.now() - t0) + ' ms)');
    const r3 = await ask('gracias');
    await check(r3.outcome === 'done' && /De nada/.test([...document.querySelectorAll('.asst-msg.ai')].pop()?.textContent || ''), 'la conversación sigue después de detener');
    await sleep(300);
    await api.test.capture('06-detenido');
  } catch (err) {
    fails.push(err.message);
    await api.test.log('ERROR ' + err.message);
    await api.test.capture('error');
  }
  await api.test.log(fails.length ? 'RESULTADO con fallos' : 'RESULTADO correcto');
  api.test.done(fails.length ? 1 : 0);
})();`
);

console.log('Abriendo LiteCut en modo de prueba con un proveedor de IA simulado…');
const t0 = Date.now();
const app = spawn(electronPath, [ROOT], {
  env: { ...process.env, LITECUT_TEST: rendererScript, LITECUT_USER_DATA: userData, LITECUT_TEST_OUT: out, LITECUT_RECORDINGS_DIR: path.join(base, 'grabaciones') },
  stdio: 'ignore',
});
const code = await new Promise((resolve) => {
  const timer = setTimeout(() => {
    app.kill();
    resolve('tiempo agotado');
  }, 8 * 60 * 1000);
  app.on('exit', (c) => {
    clearTimeout(timer);
    resolve(c);
  });
});
server.close();

let failures = 0;
const step = async (name, fn) => {
  try {
    const r = await fn();
    console.log(`  ✓ ${name}${r ? ` — ${r}` : ''}`);
  } catch (err) {
    failures++;
    console.log(`  ✗ ${name}\n    ${err.stack || err.message}`);
  }
};
const logFile = path.join(out, 'log.txt');
const lines = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split(/\r?\n/) : [];
console.log(`LiteCut se cerró (${code}) en ${((Date.now() - t0) / 1000).toFixed(0)} s. Dentro de la app:`);
for (const l of lines) console.log(`  ${l.startsWith('OK') ? '✓' : l.startsWith('RESULTADO') ? '→' : '✗'} ${l.replace(/^(OK|FALLO) /, '')}`);
console.log('Fuera de la app:');
await step('la app terminó su guion sin fallos', () => {
  assert.equal(code, 0);
  assert.ok(lines.includes('RESULTADO correcto'));
});
await step('el proveedor simulado recibió todo en el formato de OpenAI', () => {
  assert.deepEqual(problems, []);
  return `${requests.length} peticiones`;
});
await step('esperó y reintentó cuando el proveedor pidió esperar (429)', () => {
  assert.ok(rateLimited);
  const i = requests.findIndex((r, k) => k > 0 && r.messages === requests[k - 1].messages && r.last === 'tool');
  assert.ok(i > 0, 'no hubo reintento');
  const wait = requests[i].time - requests[i - 1].time;
  assert.ok(wait >= 900, `reintentó a los ${wait} ms`);
  return `reintento a los ${(wait / 1000).toFixed(1)} s`;
});
await step('Detener canceló la petición en curso', () => assert.equal(stopTest.aborted, true));
await step('la clave está cifrada en la carpeta de datos', () => {
  const file = fs.readFileSync(path.join(userData, 'asistente-claves.json'), 'utf8');
  assert.ok(!file.includes(KEY), 'la clave aparece en texto plano');
  assert.equal(JSON.parse(file).openai.hint, HINT);
});
await step('el video exportado es correcto', async () => {
  const info = await probe(exported);
  assert.equal(info.width, 640);
  assert.equal(info.height, 360);
  assert.ok(info.hasAudio);
  assert.ok(Math.abs(info.duration - 9.2) < 0.3, `duración ${info.duration}`);
  return `${info.width}×${info.height}, ${info.duration.toFixed(2)} s`;
});
console.log(`Capturas en ${out}`);
console.log(failures ? `\n${failures} comprobación(es) fallaron` : '\nPrueba del asistente correcta');
process.exit(failures ? 1 : 0);
