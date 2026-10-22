// Pruebas del asistente integrado (sin Electron): traducción de las herramientas y de la conversación al formato de
// cada proveedor (Gemini, Claude, OpenAI/OpenRouter, Ollama), lectura de sus respuestas, mensajes de error y
// llamadas HTTP de verdad contra un servidor local que imita cada API (con esperas, correcciones y cancelación).
// Uso: node scripts/test-assistant.js
import assert from 'node:assert/strict';
import http from 'node:http';
import { AI_TOOLS } from '../src/shared/ai-tools.js';
import { ASSISTANT_PROVIDERS, IMAGE_TOOLS } from '../src/shared/assistant-catalog.js';
import * as P from '../src/main/assistant-providers.js';

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

const IMG = { type: 'image', data: 'aW1hZ2Vu', mimeType: 'image/jpeg' };
// Conversación de ejemplo: dos llamadas en paralelo (una devuelve una imagen) y después un error.
const convo = () => [
  { role: 'user', text: 'Corta los silencios' },
  {
    role: 'assistant',
    text: 'Voy a mirar el proyecto.',
    calls: [
      { id: 'c1', name: 'ver_proyecto', args: {} },
      { id: 'c2', name: 'ver_fotograma', args: { tiempo: 1 } },
    ],
  },
  {
    role: 'tool',
    results: [
      { id: 'c1', name: 'ver_proyecto', content: [{ type: 'text', text: 'Proyecto «Clase»' }] },
      { id: 'c2', name: 'ver_fotograma', content: [{ type: 'text', text: 'Fotograma en 1 s' }, { ...IMG }] },
    ],
  },
  { role: 'assistant', text: '', calls: [{ id: 'c3', name: 'dividir', args: { tiempo: 99 } }] },
  { role: 'tool', results: [{ id: 'c3', name: 'dividir', content: [{ type: 'text', text: 'No hay ningún clip que dividir' }], isError: true }] },
];

// ---------- Catálogo y herramientas ----------
console.log('Proveedores y herramientas:');
await test('cada proveedor tiene adaptador, modelo por defecto y enlace', () => {
  assert.deepEqual(ASSISTANT_PROVIDERS.map((p) => p.id), ['gemini', 'claude', 'openai', 'openrouter', 'ollama']);
  for (const p of ASSISTANT_PROVIDERS) {
    assert.ok(P.ADAPTERS[p.id], `${p.id}: sin adaptador`);
    assert.match(p.keyUrl, /^https:\/\//);
    assert.match(p.baseUrl, /^https?:\/\//);
    if (p.needsKey) assert.ok(p.model && p.models.includes(p.model), `${p.id}: modelo por defecto`);
  }
});

await test('las herramientas son las del servidor MCP (sin las de imágenes si el modelo no las ve)', () => {
  const all = P.assistantTools();
  assert.equal(all.length, AI_TOOLS.length);
  for (const t of all) assert.deepEqual(Object.keys(t), ['name', 'description', 'inputSchema']);
  const blind = P.assistantTools({ images: false });
  assert.equal(blind.length, AI_TOOLS.length - IMAGE_TOOLS.length);
  assert.ok(!blind.some((t) => IMAGE_TOOLS.includes(t.name)));
  assert.match(P.assistantSystem({ platform: 'win32' }), /Windows/);
  assert.match(P.assistantSystem({ images: false }), /no recibe imágenes/);
});

await test('Gemini: esquemas en su subconjunto de OpenAPI', () => {
  const [{ functionDeclarations: decl }] = P.geminiTools(P.assistantTools());
  assert.equal(decl.length, AI_TOOLS.length);
  const allowed = new Set(['type', 'description', 'enum', 'minimum', 'maximum', 'items', 'properties', 'required']);
  const walk = (s, where) => {
    for (const k of Object.keys(s)) assert.ok(allowed.has(k), `${where}: campo «${k}»`);
    assert.ok(['STRING', 'NUMBER', 'INTEGER', 'BOOLEAN', 'ARRAY', 'OBJECT'].includes(s.type), `${where}: tipo ${s.type}`);
    if (s.enum) assert.equal(s.type, 'STRING', `${where}: enum fuera de un texto`);
    if (s.type === 'OBJECT') assert.ok(Object.keys(s.properties || {}).length, `${where}: objeto vacío`);
    if (s.required) assert.ok(s.required.length && s.required.every((r) => s.properties[r]), `${where}: required`);
    for (const [k, v] of Object.entries(s.properties || {})) walk(v, `${where}.${k}`);
    if (s.items) walk(s.items, `${where}[]`);
  };
  for (const d of decl) {
    assert.deepEqual(Object.keys(d).filter((k) => k !== 'parameters'), ['name', 'description']);
    if (d.parameters) walk(d.parameters, d.name);
  }
  const byName = Object.fromEntries(decl.map((d) => [d.name, d]));
  assert.equal(byName.ver_proyecto.parameters, undefined, 'sin parámetros no se envía un objeto vacío');
  assert.deepEqual(byName.dividir.parameters.required, ['tiempo']);
  assert.equal(byName.ajustar_clip.parameters.properties.recorte.type, 'OBJECT');
  assert.equal(Object.keys(byName.ajustar_clip.parameters.properties.recorte.properties).length, 4);
  assert.equal(byName.importar_medios.parameters.properties.rutas.items.type, 'STRING');
  assert.equal(byName.ver_fotograma.parameters.properties.ancho.maximum, 1280);
});

await test('Claude y OpenAI: el esquema tal cual', () => {
  const tools = P.assistantTools();
  const claude = P.claudeTools(tools);
  claude.forEach((t, i) => {
    assert.deepEqual(t.input_schema, AI_TOOLS[i].inputSchema);
    assert.equal(!!t.cache_control, i === claude.length - 1, 'caché solo en la última');
  });
  const openai = P.openaiTools(tools);
  openai.forEach((t, i) => {
    assert.equal(t.type, 'function');
    assert.equal(t.function.name, AI_TOOLS[i].name);
    assert.deepEqual(t.function.parameters, AI_TOOLS[i].inputSchema);
  });
});

// ---------- Conversación ----------
console.log('Conversación y resultados:');
await test('OpenAI: llamadas con argumentos en JSON, resultados como texto e imágenes en un mensaje aparte', () => {
  const m = P.openaiMessages('SISTEMA', convo(), 'openai');
  assert.deepEqual(m.map((x) => x.role), ['system', 'user', 'assistant', 'tool', 'tool', 'user', 'assistant', 'tool']);
  assert.equal(m[0].content, 'SISTEMA');
  assert.equal(m[2].tool_calls.length, 2);
  assert.equal(m[2].tool_calls[1].function.arguments, '{"tiempo":1}');
  assert.equal(m[3].tool_call_id, 'c1');
  assert.match(m[4].content, /Fotograma en 1 s\n\[La imagen va en el mensaje siguiente/);
  assert.deepEqual(m[5].content[1], { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,aW1hZ2Vu' } });
  assert.equal(m[6].content, '');
  assert.match(m[7].content, /^ERROR: No hay ningún clip/);
  assert.ok(!('reasoning_details' in m[2]));
});

await test('OpenRouter: devuelve el razonamiento de la respuesta anterior', () => {
  const c = convo();
  c[1].native = { provider: 'openrouter', data: { role: 'assistant', content: null, reasoning_details: [{ type: 'reasoning.encrypted', data: 'xyz' }] } };
  const m = P.openaiMessages('', c, 'openrouter');
  assert.deepEqual(m[1].reasoning_details, [{ type: 'reasoning.encrypted', data: 'xyz' }]);
  assert.ok(!('reasoning_details' in P.openaiMessages('', c, 'openai')[1]), 'OpenAI no lo recibe');
});

await test('Claude: tool_use y tool_result con imagen, error y caché en el último bloque', () => {
  const m = P.claudeMessages(convo());
  assert.deepEqual(m.map((x) => x.role), ['user', 'assistant', 'user', 'assistant', 'user']);
  assert.deepEqual(m[1].content[1], { type: 'tool_use', id: 'c1', name: 'ver_proyecto', input: {} });
  const [r1, r2] = m[2].content;
  assert.equal(r1.type, 'tool_result');
  assert.equal(r1.tool_use_id, 'c1');
  assert.deepEqual(r2.content[1], { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'aW1hZ2Vu' } });
  assert.equal(m[3].content.length, 1, 'sin bloque de texto vacío');
  assert.equal(m[4].content[0].is_error, true);
  assert.deepEqual(m[4].content[0].cache_control, { type: 'ephemeral' });
  assert.ok(!m[2].content.some((b) => b.cache_control), 'una sola marca de caché en la conversación');
});

await test('Claude: los bloques originales (con razonamiento firmado) se devuelven tal cual', () => {
  const c = convo();
  const original = [{ type: 'thinking', thinking: '…', signature: 'firma' }, { type: 'text', text: 'Voy a mirar el proyecto.' }, { type: 'tool_use', id: 'c1', name: 'ver_proyecto', input: {} }, { type: 'tool_use', id: 'c2', name: 'ver_fotograma', input: { tiempo: 1 } }];
  c[1].native = { provider: 'claude', data: original };
  assert.deepEqual(P.claudeMessages(c)[1].content, original);
  c.push({ role: 'assistant', text: '(interrumpido)', calls: [] }, { role: 'user', text: 'sigue' }, { role: 'user', text: 'por favor' });
  const m = P.claudeMessages(c);
  assert.deepEqual(m.slice(-1)[0].content.map((b) => b.text), ['sigue', 'por favor'], 'mensajes seguidos del mismo rol se juntan');
});

await test('Gemini 3: functionResponse con la imagen dentro y firma en llamadas que no generó Gemini', () => {
  const m = P.geminiContents(convo(), 'gemini-3.8-flash');
  assert.deepEqual(m.map((x) => x.role), ['user', 'model', 'user', 'model', 'user']);
  assert.equal(m[1].parts[1].thoughtSignature, 'skip_thought_signature_validator');
  assert.equal(m[1].parts[2].thoughtSignature, undefined, 'solo la primera llamada de cada paso');
  const [f1, f2] = m[2].parts;
  assert.deepEqual(f1.functionResponse, { name: 'ver_proyecto', response: { result: 'Proyecto «Clase»' } });
  assert.deepEqual(f2.functionResponse.parts, [{ inlineData: { mimeType: 'image/jpeg', data: 'aW1hZ2Vu' } }]);
  assert.deepEqual(m[4].parts[0].functionResponse.response, { error: 'No hay ningún clip que dividir' });
});

await test('Gemini 2.x: sin firmas e imagen como parte aparte; respuesta original y su id se respetan', () => {
  const m = P.geminiContents(convo(), 'gemini-2.5-flash');
  assert.equal(m[1].parts[1].thoughtSignature, undefined);
  assert.equal(m[2].parts.length, 3);
  assert.deepEqual(m[2].parts[2], { inlineData: { mimeType: 'image/jpeg', data: 'aW1hZ2Vu' } });
  const c = convo();
  const parts = [{ text: 'Voy a mirar el proyecto.' }, { functionCall: { id: 'g1', name: 'ver_proyecto', args: {} }, thoughtSignature: 'firma-123' }];
  c[1] = { role: 'assistant', text: 'Voy a mirar el proyecto.', calls: [{ id: 'g1', name: 'ver_proyecto', args: {}, fromProvider: true }], native: { provider: 'gemini', data: { role: 'model', parts } } };
  c[2] = { role: 'tool', results: [{ id: 'g1', name: 'ver_proyecto', content: [{ type: 'text', text: 'ok' }] }] };
  const n = P.geminiContents(c, 'gemini-3.8-flash');
  assert.deepEqual(n[1].parts, parts);
  assert.equal(n[2].parts[0].functionResponse.id, 'g1');
});

await test('Ollama: argumentos como objeto, nombre de la herramienta e imágenes en base64', () => {
  const m = P.ollamaMessages('SISTEMA', convo());
  assert.deepEqual(m.map((x) => x.role), ['system', 'user', 'assistant', 'tool', 'tool', 'user', 'assistant', 'tool']);
  assert.deepEqual(m[2].tool_calls[1], { function: { name: 'ver_fotograma', arguments: { tiempo: 1 } } });
  assert.equal(m[4].tool_name, 'ver_fotograma');
  assert.deepEqual(m[5].images, ['aW1hZ2Vu']);
});

await test('imágenes: solo se reenvían las de los últimos resultados, o ninguna', () => {
  const tool = (id) => ({ role: 'tool', results: [{ id, name: 'ver_fotograma', content: [{ type: 'text', text: id }, { ...IMG }] }] });
  const msgs = [{ role: 'user', text: 'a' }, tool('t1'), tool('t2'), tool('t3'), { role: 'tool', results: [{ id: 't4', name: 'ver_fotograma', content: [{ type: 'image', data: null, mimeType: 'image/png' }] }] }];
  const out = P.prepareMessages(msgs, { keepImages: 2 });
  const kinds = out.slice(1).map((m) => m.results[0].content.map((c) => c.type).join('+'));
  assert.deepEqual(kinds, ['text+text', 'text+image', 'text+image', 'text']);
  assert.match(out[1].results[0].content[1].text, /omitida/);
  assert.equal(msgs[1].results[0].content[1].type, 'image', 'no cambia la conversación original');
  const none = P.prepareMessages(msgs, { images: false });
  assert.ok(none.every((m) => m.role !== 'tool' || m.results[0].content.every((c) => c.type === 'text')));
  assert.match(none[3].results[0].content[1].text, /no enviar imágenes/);
});

// ---------- Respuestas ----------
console.log('Respuestas de los proveedores:');
await test('Gemini: texto, llamadas y firma conservada; filtros y llamadas mal formadas', () => {
  const parts = [{ text: 'Pienso…', thought: true }, { text: 'Corto los silencios.' }, { functionCall: { name: 'cortar_silencios', args: { margen: 0.1 } }, thoughtSignature: 'sig' }];
  const r = P.ADAPTERS.gemini.parse({ candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 5 } });
  assert.equal(r.text, 'Corto los silencios.');
  assert.equal(r.calls[0].name, 'cortar_silencios');
  assert.deepEqual(r.calls[0].args, { margen: 0.1 });
  assert.equal(r.calls[0].fromProvider, false);
  assert.equal(r.native.data.parts[2].thoughtSignature, 'sig');
  assert.equal(r.stop, 'tool');
  assert.deepEqual(r.usage, { input: 100, output: 25 });
  assert.throws(() => P.ADAPTERS.gemini.parse({ candidates: [{ finishReason: 'SAFETY' }] }), (e) => e.code === 'blocked');
  assert.throws(() => P.ADAPTERS.gemini.parse({ promptFeedback: { blockReason: 'OTHER' } }), (e) => e.code === 'blocked');
  assert.equal(P.ADAPTERS.gemini.parse({ candidates: [{ finishReason: 'MALFORMED_FUNCTION_CALL' }] }).retry, true);
});

await test('Claude: texto y tool_use (los bloques de razonamiento quedan en la respuesta original)', () => {
  const content = [{ type: 'thinking', thinking: '…', signature: 's' }, { type: 'text', text: 'Listo.' }, { type: 'tool_use', id: 'toolu_1', name: 'ver_proyecto', input: {} }];
  const r = P.ADAPTERS.claude.parse({ content, stop_reason: 'tool_use', usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 7 } });
  assert.equal(r.text, 'Listo.');
  assert.deepEqual(r.calls[0], { id: 'toolu_1', name: 'ver_proyecto', args: {}, fromProvider: true });
  assert.deepEqual(r.native.data, content);
  assert.deepEqual(r.usage, { input: 100, output: 7 });
  assert.equal(P.ADAPTERS.claude.parse({ content: [{ type: 'text', text: 'Hola' }], stop_reason: 'max_tokens' }).stop, 'length');
});

await test('OpenAI: argumentos JSON (también inválidos) y sin el razonamiento <think>', () => {
  const r = P.ADAPTERS.openai.parse({
    choices: [{ message: { role: 'assistant', content: '<think>mmm</think>Hecho', tool_calls: [{ id: 'a', type: 'function', function: { name: 'dividir', arguments: '{"tiempo": 3}' } }, { id: 'b', type: 'function', function: { name: 'dividir', arguments: '{tiempo: 3' } }] }, finish_reason: 'tool_calls' }],
    usage: { prompt_tokens: 5, completion_tokens: 6 },
  });
  assert.equal(r.text, 'Hecho');
  assert.deepEqual(r.calls[0].args, { tiempo: 3 });
  assert.match(r.calls[1].argsError, /no son un objeto JSON válido/);
  assert.equal(r.calls[1].rawArgs, '{tiempo: 3');
  assert.equal(P.openaiMessages('', [{ role: 'assistant', text: '', calls: r.calls }])[0].tool_calls[1].function.arguments, '{tiempo: 3', 'se devuelve tal cual llegó');
  assert.throws(() => P.ADAPTERS.openai.parse({ error: { message: 'x' } }), (e) => e.code === 'response');
});

await test('Ollama: llamadas con argumentos como objeto y fin por longitud', () => {
  const r = P.ADAPTERS.ollama.parse({ message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'agregar_texto', arguments: { texto: 'Hola' } } }] }, done: true, done_reason: 'stop', prompt_eval_count: 3, eval_count: 4 });
  assert.deepEqual(r.calls[0].args, { texto: 'Hola' });
  assert.deepEqual(r.usage, { input: 3, output: 4 });
  assert.equal(P.ADAPTERS.ollama.parse({ message: { content: 'Hola' }, done_reason: 'length' }).stop, 'length');
});

await test('errores HTTP con mensajes claros en español', () => {
  const gem429 = (quotaId, delay) => ({ error: { code: 429, message: 'You exceeded your current quota', status: 'RESOURCE_EXHAUSTED', details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId }] }, { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: delay }] } });
  let e = P.httpError('gemini', 429, gem429('GenerateRequestsPerMinutePerProjectPerModel-FreeTier', '35s'));
  assert.equal(e.code, 'rate');
  assert.equal(e.retryAfter, 35);
  e = P.httpError('gemini', 429, gem429('GenerateRequestsPerDayPerProjectPerModel-FreeTier', '3600s'));
  assert.equal(e.code, 'quota');
  assert.match(e.message, /cupo diario/);
  e = P.httpError('gemini', 400, { error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' } });
  assert.equal(e.code, 'auth');
  assert.match(e.message, /clave/);
  assert.equal(P.httpError('gemini', 400, { error: { message: 'User location is not supported for the API use.' } }).code, 'request');
  assert.equal(P.httpError('openai', 429, { error: { message: 'You exceeded your current quota', code: 'insufficient_quota' } }).code, 'quota');
  assert.equal(P.httpError('claude', 400, { type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' } }).code, 'quota');
  assert.equal(P.httpError('claude', 529, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }).code, 'server');
  assert.equal(P.httpError('openai', 404, { error: { message: 'The model `gpt-9` does not exist' } }).code, 'model');
  e = P.httpError('ollama', 404, { error: "model 'llama9' not found" });
  assert.equal(e.code, 'model');
  assert.match(e.message, /ollama pull llama9/);
  assert.equal(P.httpError('ollama', 400, { error: 'registry.ollama.ai/library/gemma:2b does not support tools' }).code, 'model');
  assert.equal(P.httpError('openrouter', 429, { error: { message: 'Rate limit exceeded: free-models-per-day' } }).code, 'quota');
  assert.equal(P.httpError('claude', 429, { error: { message: 'rate' } }, new Headers({ 'retry-after': '7' })).retryAfter, 7);
  assert.equal(P.httpError('openai', 400, { error: { message: "This model's maximum context length is 128000 tokens" } }).code, 'too_big');
});

await test('peticiones a las direcciones oficiales de cada proveedor', () => {
  const o = { key: 'k', system: 'S', messages: [{ role: 'user', text: 'hola' }], tools: P.assistantTools(), maxTokens: 100 };
  const g = P.ADAPTERS.gemini.request({ ...o, model: 'gemini-3.8-flash' });
  assert.equal(g.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent');
  assert.equal(g.body.generationConfig.maxOutputTokens, 100);
  assert.equal(P.ADAPTERS.claude.request({ ...o, model: 'claude-haiku-5-5' }).url, 'https://api.anthropic.com/v1/messages');
  // OpenAI: sus modelos de razonamiento solo usan herramientas en Chat Completions con reasoning_effort «none».
  const a = P.ADAPTERS.openai.request({ ...o, model: 'gpt-6-luna' });
  assert.equal(a.url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(a.body.reasoning_effort, 'none');
  assert.equal(a.body.max_completion_tokens, 100);
  assert.equal(P.ADAPTERS.openai.request({ ...o, model: 'gpt-4.1-mini' }).body.reasoning_effort, undefined);
  const fixed = new Set();
  assert.equal(P.ADAPTERS.openai.fix(a.body, "Unsupported parameter: 'reasoning_effort' is not supported with this model.", fixed), true);
  assert.equal(a.body.reasoning_effort, undefined);
  const b = P.ADAPTERS.openai.request({ ...o, model: 'gpt-6-luna' });
  delete b.body.reasoning_effort;
  assert.equal(P.ADAPTERS.openai.fix(b.body, 'Function tools with reasoning_effort are not supported for gpt-6-luna in /v1/chat/completions.', new Set()), true);
  assert.equal(b.body.reasoning_effort, 'none');
  const r = P.ADAPTERS.openrouter.request({ ...o, model: 'google/gemini-3.8-flash' });
  assert.equal(r.url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(r.headers['X-Title'], 'LiteCut Studio');
  assert.equal(P.ADAPTERS.ollama.request({ ...o, model: 'q' }).url, 'http://localhost:11434/api/chat');
});

// ---------- HTTP de verdad contra servidores locales ----------
console.log('Llamadas HTTP (servidor local que imita cada API):');
const seen = [];
const counters = new Map();
const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (d) => (raw += d));
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : null;
    seen.push({ method: req.method, url: req.url, headers: req.headers, body });
    const n = (counters.get(req.url) || 0) + 1;
    counters.set(req.url, n);
    const json = (status, data, headers = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(data));
    };
    if (req.url.startsWith('/lento')) return void setTimeout(() => json(200, {}), 3000);
    if (req.url === '/gemini/models/gemini-3.8-flash:generateContent') {
      if (n === 1) return json(429, { error: { code: 429, message: 'Quota exceeded. Please retry in 0.2s.', status: 'RESOURCE_EXHAUSTED', details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '0.2s' }] } });
      return json(200, { candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'ver_proyecto', args: {} }, thoughtSignature: 'abc' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 1 } });
    }
    if (req.url === '/gemini/models?pageSize=1000') {
      return json(200, { models: [{ name: 'models/gemini-3.8-flash', displayName: 'Gemini 3.8 Flash', supportedGenerationMethods: ['generateContent'] }, { name: 'models/gemini-3.8-flash-tts', supportedGenerationMethods: ['generateContent'] }, { name: 'models/gemini-embedding-001', supportedGenerationMethods: ['embedContent'] }] });
    }
    if (req.url === '/claude/messages') return json(200, { content: [{ type: 'text', text: 'Hola' }], stop_reason: 'end_turn', usage: { input_tokens: 3, output_tokens: 1 } });
    if (req.url === '/openai/chat/completions') return json(200, { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'dividir', arguments: '{"tiempo":2}' } }] }, finish_reason: 'tool_calls' }] });
    if (req.url === '/openai-fix/chat/completions') {
      if (body.max_tokens !== undefined) return json(400, { error: { message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.", type: 'invalid_request_error' } });
      return json(200, { choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] });
    }
    if (req.url === '/ollama/api/chat') return json(200, { message: { role: 'assistant', content: 'Listo' }, done: true, done_reason: 'stop' });
    if (req.url === '/ollama/api/tags') return json(200, { models: [{ name: 'qwen-pequeno:4b', details: { parameter_size: '4B' } }, { name: 'sin-herramientas:2b' }] });
    if (req.url === '/ollama/api/show') return json(200, { capabilities: body.model.startsWith('qwen') ? ['completion', 'tools', 'vision'] : ['completion'] });
    return json(404, { error: { message: `ruta desconocida ${req.url}` } });
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const tools = P.assistantTools();
const last = () => seen[seen.length - 1];

await test('Gemini: clave en la cabecera (nunca en la URL), espera si pide esperar y reintenta', async () => {
  const waits = [];
  const r = await P.chat({ provider: 'gemini', model: 'gemini-3.8-flash', key: 'clave-g', baseUrl: `${base}/gemini`, system: 'S', tools, messages: [{ role: 'user', text: 'hola' }], onWait: (w) => waits.push(w) });
  assert.equal(r.calls[0].name, 'ver_proyecto');
  assert.equal(r.native.data.parts[0].thoughtSignature, 'abc');
  assert.deepEqual(waits.map((w) => [w.seconds, w.reason]), [[1, 'rate']]);
  assert.equal(counters.get('/gemini/models/gemini-3.8-flash:generateContent'), 2);
  const req = last();
  assert.equal(req.headers['x-goog-api-key'], 'clave-g');
  assert.ok(!req.url.includes('clave-g'));
  assert.equal(req.body.systemInstruction.parts[0].text, 'S');
  assert.equal(req.body.tools[0].functionDeclarations.length, AI_TOOLS.length);
});

await test('Claude: cabeceras de la API, sistema con caché y respuesta', async () => {
  const r = await P.chat({ provider: 'claude', model: 'claude-haiku-5-5', key: 'clave-c', baseUrl: `${base}/claude`, system: 'S', tools, messages: [{ role: 'user', text: 'hola' }] });
  assert.equal(r.text, 'Hola');
  const req = last();
  assert.equal(req.headers['x-api-key'], 'clave-c');
  assert.equal(req.headers['anthropic-version'], '2023-06-01');
  assert.deepEqual(req.body.system[0].cache_control, { type: 'ephemeral' });
  assert.equal(req.body.max_tokens, 8192);
});

await test('compatible con OpenAI: Bearer, herramientas y corrección de parámetros que el servidor no acepta', async () => {
  const r = await P.chat({ provider: 'openai', model: 'gpt-6-luna', key: 'clave-o', baseUrl: `${base}/openai`, system: 'S', tools, messages: [{ role: 'user', text: 'hola' }] });
  assert.deepEqual(r.calls[0].args, { tiempo: 2 });
  let req = last();
  assert.equal(req.headers.authorization, 'Bearer clave-o');
  assert.equal(req.body.tool_choice, 'auto');
  assert.equal(req.body.reasoning_effort, undefined, 'solo para la API oficial de OpenAI');
  assert.equal(req.body.max_tokens, 8192);
  const r2 = await P.chat({ provider: 'openai', model: 'otro', key: 'clave-o', baseUrl: `${base}/openai-fix`, tools, messages: [{ role: 'user', text: 'hola' }] });
  assert.equal(r2.text, 'ok');
  req = last();
  assert.equal(req.body.max_completion_tokens, 8192);
  assert.equal(req.body.max_tokens, undefined);
});

await test('Ollama: API propia con más contexto, y lista de modelos con lo que saben hacer', async () => {
  const r = await P.chat({ provider: 'ollama', model: 'qwen-pequeno:4b', baseUrl: `${base}/ollama/v1`, system: 'S', tools, messages: [{ role: 'user', text: 'hola' }] });
  assert.equal(r.text, 'Listo');
  const req = last();
  assert.equal(req.url, '/ollama/api/chat');
  assert.equal(req.body.stream, false);
  assert.equal(req.body.options.num_ctx, 16384);
  const models = await P.listModels({ provider: 'ollama', baseUrl: `${base}/ollama` });
  assert.deepEqual(models.map((m) => [m.id, m.tools, m.images]), [['qwen-pequeno:4b', true, true], ['sin-herramientas:2b', false, false]]);
  const gem = await P.listModels({ provider: 'gemini', key: 'k', baseUrl: `${base}/gemini` });
  assert.deepEqual(gem.map((m) => m.id), ['gemini-3.8-flash']);
});

await test('detener, tiempo agotado, sin conexión, sin clave', async () => {
  const ac = new AbortController();
  const t0 = Date.now();
  setTimeout(() => ac.abort(), 150);
  await assert.rejects(P.chat({ provider: 'openai', model: 'm', key: 'k', baseUrl: `${base}/lento`, messages: [{ role: 'user', text: 'x' }], signal: ac.signal }), (e) => e.code === 'cancelled');
  assert.ok(Date.now() - t0 < 2000, 'se detiene enseguida');
  await assert.rejects(P.chat({ provider: 'openai', model: 'm', key: 'k', baseUrl: `${base}/lento`, messages: [{ role: 'user', text: 'x' }], timeout: 300 }), (e) => e.code === 'timeout');
  await assert.rejects(P.chat({ provider: 'ollama', model: 'm', baseUrl: 'http://127.0.0.1:9', messages: [{ role: 'user', text: 'x' }] }), (e) => e.code === 'network' && /Ollama/.test(e.message));
  await assert.rejects(P.chat({ provider: 'gemini', model: 'gemini-3.8-flash', key: '', messages: [] }), (e) => e.code === 'nokey');
  await assert.rejects(P.chat({ provider: 'claude', model: ' ', key: 'k', messages: [] }), (e) => e.code === 'model');
});

server.close();
console.log(failed ? `\n${failed} prueba(s) fallaron` : `\n${passed} pruebas correctas`);
process.exit(failed ? 1 : 0);
