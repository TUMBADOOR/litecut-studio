// Adaptadores del asistente integrado para cada proveedor de IA (Gemini, Claude, OpenAI, OpenRouter y Ollama).
// No dependen de Electron (se prueban con Node): reciben la función fetch que deben usar; en la app es la de
// Electron, que respeta el proxy y los certificados del sistema.
//
// La conversación se guarda en un formato neutral, igual para todos los proveedores:
//   { role: 'user', text }
//   { role: 'assistant', text, calls: [{ id, name, args, fromProvider? }], native?: { provider, data } }
//   { role: 'tool', results: [{ id, name, content: [{ type: 'text', text } | { type: 'image', data, mimeType }], isError? }] }
// «content» es el mismo que devuelven las herramientas (estilo MCP). «native» conserva la respuesta original del
// proveedor (firmas de razonamiento de Gemini, bloques de Claude…) para devolvérsela tal cual en el paso siguiente,
// como exigen esas API.
import { AI_INSTRUCTIONS, mcpToolList } from '../shared/ai-tools.js';
import { PROVIDER_MAP, IMAGE_TOOLS } from '../shared/assistant-catalog.js';

export class AssistantError extends Error {
  // code: cancelled, nokey, auth, model, quota, rate, server, network, timeout, blocked, too_big, request, response
  constructor(code, message, { status = 0, retryAfter = null, details = '' } = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
    this.details = details;
  }
}

const cancelled = () => new AssistantError('cancelled', 'Detenido.');
const nameOf = (provider) => PROVIDER_MAP.get(provider)?.name || provider;
const clone = (v) => JSON.parse(JSON.stringify(v));
const trimSlash = (u) => String(u || '').trim().replace(/\/+$/, '');
const textOf = (content = []) => content.filter((c) => c.type === 'text' && c.text).map((c) => c.text).join('\n');
const imagesOf = (content = []) => content.filter((c) => c.type === 'image' && c.data);
const stripThink = (s) => String(s || '').replace(/<think>[\s\S]*?<\/think>/g, '');

let seq = 0;
export const newCallId = () => `call_${Date.now().toString(36)}_${(++seq).toString(36)}`;

// ---------- Lo que recibe la IA ----------
export function assistantTools({ images = true } = {}) {
  return mcpToolList()
    .filter((t) => images || !IMAGE_TOOLS.includes(t.name))
    .map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
}

export function assistantSystem({ images = true, platform = process.platform } = {}) {
  const os = platform === 'darwin' ? 'macOS' : platform === 'win32' ? 'Windows' : 'Linux';
  return [
    'Eres el asistente de edición de video integrado en LiteCut Studio. El usuario te escribe desde un panel de chat dentro de la app y ve al instante cada cambio que haces.',
    AI_INSTRUCTIONS,
    'Cómo trabajar:',
    '- Haz tú los cambios con las herramientas; no expliques cómo hacerlos a mano salvo que te lo pidan.',
    '- Usa ver_proyecto al empezar (y si el usuario abrió otro proyecto) para conocer los ids actuales.',
    '- Si falta un dato importante (qué archivo importar, qué texto poner…), pregunta en vez de inventarlo. Nunca inventes rutas de archivos.',
    images
      ? '- Para revisar cómo quedó un texto o el encuadre, usa ver_fotograma con formato jpeg y ancho 512.'
      : '- Este modelo no recibe imágenes: guíate por ver_proyecto y por los análisis (silencios, escenas).',
    '- No exportes ni guardes el proyecto salvo que el usuario lo pida.',
    '- Responde en el idioma del usuario (normalmente español), breve y sin tecnicismos. Al terminar, resume en una o dos frases qué cambiaste; cada cambio se deshace con Ctrl+Z.',
    `- El equipo del usuario usa ${os}.`,
  ].join('\n');
}

// Antes de enviar: solo se reenvían las imágenes de los últimos resultados (las anteriores se cambian por un aviso
// para no subir lo mismo en cada paso) y ninguna si el modelo no ve imágenes.
const OLD_IMAGE = '[Imagen anterior omitida para ahorrar datos: vuelve a pedirla si la necesitas.]';
const NO_IMAGES = '[Imagen no enviada: el asistente está configurado para no enviar imágenes.]';

export function prepareMessages(messages, { images = true, keepImages = 2 } = {}) {
  let left = images ? keepImages : 0;
  const out = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const hasImages = m.role === 'tool' && m.results.some((r) => r.content?.some((c) => c.type === 'image'));
    if (!hasImages) {
      out.push(m);
      continue;
    }
    const keep = left > 0 && m.results.some((r) => imagesOf(r.content).length);
    if (keep) left--;
    out.push({
      ...m,
      results: m.results.map((r) => ({
        ...r,
        content: (r.content || []).map((c) => (c.type !== 'image' || (keep && c.data) ? c : { type: 'text', text: images ? OLD_IMAGE : NO_IMAGES })),
      })),
    });
  }
  return out.reverse();
}

// ---------- Esquemas de las herramientas ----------
// Gemini usa un subconjunto de OpenAPI: tipos en mayúsculas, sin objetos vacíos ni «required» vacío.
export function geminiSchema(s) {
  const out = { type: String(s.type || 'string').toUpperCase() };
  if (s.description) out.description = s.description;
  if (s.enum) out.enum = s.enum.map(String);
  if (s.minimum !== undefined) out.minimum = s.minimum;
  if (s.maximum !== undefined) out.maximum = s.maximum;
  if (s.type === 'array') out.items = geminiSchema(s.items || { type: 'string' });
  if (s.type === 'object') {
    const props = Object.entries(s.properties || {});
    if (props.length) out.properties = Object.fromEntries(props.map(([k, v]) => [k, geminiSchema(v)]));
    if (s.required?.length) out.required = [...s.required];
  }
  return out;
}

export function geminiTools(tools) {
  const declarations = tools.map((t) => {
    const d = { name: t.name, description: t.description };
    if (Object.keys(t.inputSchema.properties || {}).length) d.parameters = geminiSchema(t.inputSchema);
    return d;
  });
  return [{ functionDeclarations: declarations }];
}

// Claude: el esquema tal cual. La marca de caché en la última herramienta evita pagar la lista completa en cada paso.
export function claudeTools(tools) {
  return tools.map((t, i) => {
    const d = { name: t.name, description: t.description, input_schema: t.inputSchema };
    if (i === tools.length - 1) d.cache_control = { type: 'ephemeral' };
    return d;
  });
}

export function openaiTools(tools) {
  return tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
}

function toCall(id, name, rawArgs) {
  const call = { id: id || newCallId(), name, args: {}, fromProvider: !!id };
  if (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)) call.args = rawArgs;
  else if (typeof rawArgs === 'string' && rawArgs.trim()) {
    try {
      const v = JSON.parse(rawArgs);
      if (v && typeof v === 'object' && !Array.isArray(v)) call.args = v;
      else throw new Error('no es un objeto');
    } catch {
      call.argsError = `Los argumentos no son un objeto JSON válido: ${rawArgs.slice(0, 300)}`;
      call.rawArgs = rawArgs;
    }
  }
  return call;
}

// ---------- Gemini (generateContent) ----------
const GEMINI_LEGACY = /^(models\/)?gemini-[12][.-]/; // 1.x y 2.x: sin firmas obligatorias ni imágenes dentro de functionResponse
const SKIP_SIGNATURE = 'skip_thought_signature_validator';

export function geminiContents(messages, model = '') {
  const legacy = GEMINI_LEGACY.test(model);
  const ownIds = new Set();
  for (const m of messages) if (m.role === 'assistant' && m.native?.provider === 'gemini') for (const c of m.calls || []) if (c.fromProvider) ownIds.add(c.id);
  const out = [];
  const push = (role, parts) => {
    if (!parts.length) return;
    const last = out[out.length - 1];
    if (last?.role === role) last.parts.push(...parts);
    else out.push({ role, parts });
  };
  for (const m of messages) {
    if (m.role === 'user') push('user', [{ text: m.text || ' ' }]);
    else if (m.role === 'assistant') {
      if (m.native?.provider === 'gemini' && m.native.data?.parts?.length) {
        push('model', clone(m.native.data.parts)); // con sus firmas, sin tocar
        continue;
      }
      const parts = m.text ? [{ text: m.text }] : [];
      (m.calls || []).forEach((c, i) => {
        const part = { functionCall: { name: c.name, args: c.args || {} } };
        // Llamadas que no generó Gemini (conversación empezada con otro proveedor): los modelos 3.x exigen firma.
        if (i === 0 && !legacy) part.thoughtSignature = SKIP_SIGNATURE;
        parts.push(part);
      });
      push('model', parts.length ? parts : [{ text: ' ' }]);
    } else if (m.role === 'tool') {
      const parts = [];
      const extra = [];
      for (const r of m.results) {
        const text = textOf(r.content) || (r.isError ? 'Error.' : 'Hecho.');
        const fr = { name: r.name, response: r.isError ? { error: text } : { result: text } };
        if (ownIds.has(r.id)) fr.id = r.id;
        const blobs = imagesOf(r.content).map((img) => ({ inlineData: { mimeType: img.mimeType || 'image/png', data: img.data } }));
        if (blobs.length && legacy) extra.push(...blobs);
        else if (blobs.length) fr.parts = blobs;
        parts.push({ functionResponse: fr });
      }
      push('user', [...parts, ...extra]);
    }
  }
  return out;
}

function geminiRequest({ model, key, baseUrl, system, messages, tools, maxTokens }) {
  const base = trimSlash(baseUrl) || PROVIDER_MAP.get('gemini').baseUrl;
  const body = { contents: geminiContents(messages, model), generationConfig: { maxOutputTokens: maxTokens } };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  if (tools?.length) body.tools = geminiTools(tools);
  const name = String(model).trim().replace(/^models\//, '');
  return { url: `${base}/models/${encodeURIComponent(name)}:generateContent`, headers: { 'content-type': 'application/json', 'x-goog-api-key': key }, body };
}

const GEMINI_BLOCKED = ['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'RECITATION', 'IMAGE_SAFETY'];
const GEMINI_CONFUSED = ['MALFORMED_FUNCTION_CALL', 'UNEXPECTED_TOOL_CALL', 'MISSING_THOUGHT_SIGNATURE', 'MALFORMED_RESPONSE'];

function geminiParse(json) {
  const cand = json?.candidates?.[0];
  if (!cand) {
    const reason = json?.promptFeedback?.blockReason;
    throw new AssistantError('blocked', reason ? `Gemini rechazó el mensaje (${reason}). Reformúlalo.` : 'Gemini no devolvió ninguna respuesta.');
  }
  const parts = cand.content?.parts || [];
  const text = parts.filter((p) => typeof p.text === 'string' && !p.thought).map((p) => p.text).join('').trim();
  const calls = parts.filter((p) => p.functionCall?.name).map((p) => toCall(p.functionCall.id, p.functionCall.name, p.functionCall.args || {}));
  const fr = cand.finishReason || '';
  const u = json.usageMetadata || {};
  const out = {
    text,
    calls,
    native: { provider: 'gemini', data: { role: 'model', parts } },
    stop: calls.length ? 'tool' : fr === 'MAX_TOKENS' ? 'length' : 'end',
    usage: { input: u.promptTokenCount || 0, output: (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0) },
  };
  if (!calls.length && !text) {
    if (GEMINI_BLOCKED.includes(fr)) throw new AssistantError('blocked', `Gemini no respondió por sus filtros de contenido (${fr}). Reformula el pedido.`);
    if (GEMINI_CONFUSED.includes(fr)) out.retry = true;
  }
  return out;
}

// ---------- Claude (Messages API) ----------
function claudeContent(content) {
  const out = (content || [])
    .map((c) => (c.type === 'image' && c.data ? { type: 'image', source: { type: 'base64', media_type: c.mimeType || 'image/png', data: c.data } } : c.type === 'text' && c.text ? { type: 'text', text: c.text } : null))
    .filter(Boolean);
  return out.length ? out : [{ type: 'text', text: 'Hecho.' }];
}

export function claudeMessages(messages) {
  const out = [];
  const push = (role, blocks) => {
    if (!blocks.length) return;
    const last = out[out.length - 1];
    if (last?.role === role) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  };
  for (const m of messages) {
    if (m.role === 'user') push('user', [{ type: 'text', text: m.text || '…' }]);
    else if (m.role === 'assistant') {
      if (m.native?.provider === 'claude' && Array.isArray(m.native.data) && m.native.data.length) {
        push('assistant', clone(m.native.data)); // incluidos los bloques de razonamiento con su firma
        continue;
      }
      const blocks = m.text ? [{ type: 'text', text: m.text }] : [];
      for (const c of m.calls || []) blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: c.args || {} });
      push('assistant', blocks.length ? blocks : [{ type: 'text', text: '…' }]);
    } else if (m.role === 'tool') {
      push('user', m.results.map((r) => ({ type: 'tool_result', tool_use_id: r.id, content: claudeContent(r.content), ...(r.isError ? { is_error: true } : {}) })));
    }
  }
  // Caché de la conversación hasta el último mensaje: el paso siguiente solo paga lo nuevo.
  const last = out[out.length - 1];
  if (last) last.content[last.content.length - 1].cache_control = { type: 'ephemeral' };
  return out;
}

function claudeRequest({ model, key, baseUrl, system, messages, tools, maxTokens }) {
  const base = trimSlash(baseUrl) || PROVIDER_MAP.get('claude').baseUrl;
  const body = { model, max_tokens: maxTokens, messages: claudeMessages(messages) };
  if (system) body.system = [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
  if (tools?.length) body.tools = claudeTools(tools);
  return { url: `${base}/messages`, headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' }, body };
}

function claudeParse(json) {
  const content = Array.isArray(json?.content) ? json.content : [];
  const text = content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  const calls = content.filter((b) => b.type === 'tool_use').map((b) => toCall(b.id, b.name, b.input || {}));
  if (json?.stop_reason === 'refusal' && !calls.length && !text) throw new AssistantError('blocked', 'Claude prefirió no responder a este pedido. Reformúlalo.');
  const u = json?.usage || {};
  return {
    text,
    calls,
    native: { provider: 'claude', data: content },
    stop: calls.length ? 'tool' : json?.stop_reason === 'max_tokens' ? 'length' : 'end',
    usage: { input: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0), output: u.output_tokens || 0 },
  };
}

// ---------- OpenAI y OpenRouter (Chat Completions) ----------
// Los resultados de herramientas solo admiten texto: las imágenes van después, en un mensaje del usuario.
export function openaiMessages(system, messages, provider = 'openai') {
  const out = system ? [{ role: 'system', content: system }] : [];
  for (const m of messages) {
    if (m.role === 'user') out.push({ role: 'user', content: m.text || '' });
    else if (m.role === 'assistant') {
      const msg = { role: 'assistant', content: m.text || '' };
      if (m.calls?.length) msg.tool_calls = m.calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.rawArgs ?? JSON.stringify(c.args || {}) } }));
      // OpenRouter pide devolver el razonamiento (firmas de Gemini, Claude…) junto con las llamadas.
      if (provider === 'openrouter' && m.native?.provider === 'openrouter' && m.native.data?.reasoning_details) msg.reasoning_details = clone(m.native.data.reasoning_details);
      out.push(msg);
    } else if (m.role === 'tool') {
      const pics = [];
      for (const r of m.results) {
        const imgs = imagesOf(r.content);
        let text = textOf(r.content) || (r.isError ? 'Error.' : 'Hecho.');
        if (imgs.length) {
          text += `\n[${imgs.length === 1 ? 'La imagen va' : `Las ${imgs.length} imágenes van`} en el mensaje siguiente.]`;
          pics.push(...imgs);
        }
        out.push({ role: 'tool', tool_call_id: r.id, content: r.isError ? `ERROR: ${text}` : text });
      }
      if (pics.length) {
        out.push({ role: 'user', content: [{ type: 'text', text: 'Imágenes devueltas por las herramientas:' }, ...pics.map((p) => ({ type: 'image_url', image_url: { url: `data:${p.mimeType || 'image/png'};base64,${p.data}` } }))] });
      }
    }
  }
  return out;
}

const isOfficialOpenAI = (base) => /^https:\/\/api\.openai\.com(\/|$)/i.test(base);

function openaiRequest(provider, { model, key, baseUrl, system, messages, tools, maxTokens }) {
  const base = trimSlash(baseUrl) || PROVIDER_MAP.get(provider).baseUrl;
  const body = { model, messages: openaiMessages(system, messages, provider) };
  if (tools?.length) {
    body.tools = openaiTools(tools);
    body.tool_choice = 'auto';
  }
  const official = provider === 'openai' && isOfficialOpenAI(base);
  if (official) body.max_completion_tokens = maxTokens;
  else body.max_tokens = maxTokens;
  // Los modelos de razonamiento recientes de OpenAI solo usan herramientas en Chat Completions sin razonamiento.
  if (official && tools?.length && /^(gpt-(5\.[1-9]|[6-9])|o[5-9])/.test(model)) body.reasoning_effort = 'none';
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${key}` };
  if (provider === 'openrouter') headers['X-Title'] = 'LiteCut Studio';
  return { url: `${base}/chat/completions`, headers, body };
}

// Si el servidor rechaza un parámetro, se corrige y se reintenta una vez (cambian según el modelo y el servidor).
function openaiFix(body, message, done) {
  const m = String(message || '').toLowerCase();
  const once = (k, fn) => {
    if (done.has(k)) return false;
    done.add(k);
    fn();
    return true;
  };
  if (m.includes('reasoning_effort') || m.includes('reasoning effort')) {
    if (body.reasoning_effort !== undefined && !/set .*none|to .?none|must be .?none/.test(m)) return once('reasoning-', () => delete body.reasoning_effort);
    if (body.reasoning_effort === undefined && body.tools) return once('reasoning+', () => (body.reasoning_effort = 'none'));
  }
  // max_tokens / max_completion_tokens: cada servidor acepta uno; algunos modelos admiten menos de 8192.
  const rejected = /unsupported|not supported|unrecognized|unknown/.test(m);
  for (const [k, other] of [
    ['max_tokens', 'max_completion_tokens'],
    ['max_completion_tokens', 'max_tokens'],
  ]) {
    if (body[k] === undefined || !new RegExp(`\\b${k}\\b`).test(m)) continue;
    if (rejected) {
      return once(`swap-${k}`, () => {
        body[other] = body[k];
        delete body[k];
      });
    }
    if (body[k] > 4096) return once(`small-${k}`, () => (body[k] = 4096));
  }
  return false;
}

function openaiParse(json, provider) {
  const choice = json?.choices?.[0];
  if (!choice) throw new AssistantError('response', `Respuesta inesperada de ${nameOf(provider)}${json?.error?.message ? `: ${json.error.message}` : ''}.`);
  if (choice.error) throw new AssistantError('server', `${nameOf(provider)}: ${choice.error.message || 'error del modelo'}`, { details: JSON.stringify(choice.error).slice(0, 500) });
  const m = choice.message || {};
  const raw = typeof m.content === 'string' ? m.content : Array.isArray(m.content) ? m.content.map((p) => p.text || '').join('') : '';
  const calls = (m.tool_calls || []).filter((t) => t.function?.name).map((t) => toCall(t.id, t.function.name, t.function.arguments));
  const data = { role: 'assistant', content: m.content ?? null };
  if (m.reasoning_details) data.reasoning_details = m.reasoning_details;
  const u = json.usage || {};
  return {
    text: stripThink(raw).trim(),
    calls,
    native: { provider, data },
    stop: calls.length ? 'tool' : choice.finish_reason === 'length' ? 'length' : 'end',
    usage: { input: u.prompt_tokens || 0, output: u.completion_tokens || 0 },
  };
}

// ---------- Ollama (API propia: permite pedir más contexto que la compatible con OpenAI) ----------
const OLLAMA_CONTEXT = 16384; // las 27 herramientas ocupan unos 8000 tokens; con el valor por defecto se recortarían
export const ollamaBase = (u) => trimSlash(u || PROVIDER_MAP.get('ollama').baseUrl).replace(/\/(v1|api)$/i, '');

export function ollamaMessages(system, messages) {
  const out = system ? [{ role: 'system', content: system }] : [];
  for (const m of messages) {
    if (m.role === 'user') out.push({ role: 'user', content: m.text || '' });
    else if (m.role === 'assistant') {
      const msg = { role: 'assistant', content: m.text || '' };
      if (m.calls?.length) msg.tool_calls = m.calls.map((c) => ({ function: { name: c.name, arguments: c.args || {} } }));
      out.push(msg);
    } else if (m.role === 'tool') {
      const pics = [];
      for (const r of m.results) {
        const imgs = imagesOf(r.content);
        let text = textOf(r.content) || (r.isError ? 'Error.' : 'Hecho.');
        if (imgs.length) {
          text += `\n[${imgs.length === 1 ? 'La imagen va' : `Las ${imgs.length} imágenes van`} en el mensaje siguiente.]`;
          pics.push(...imgs.map((i) => i.data));
        }
        out.push({ role: 'tool', content: r.isError ? `ERROR: ${text}` : text, tool_name: r.name });
      }
      if (pics.length) out.push({ role: 'user', content: 'Imágenes devueltas por las herramientas:', images: pics });
    }
  }
  return out;
}

function ollamaRequest({ model, baseUrl, system, messages, tools, maxTokens }) {
  const body = { model, messages: ollamaMessages(system, messages), stream: false, options: { num_ctx: OLLAMA_CONTEXT, num_predict: maxTokens } };
  if (tools?.length) body.tools = openaiTools(tools);
  return { url: `${ollamaBase(baseUrl)}/api/chat`, headers: { 'content-type': 'application/json' }, body };
}

function ollamaParse(json) {
  const m = json?.message;
  if (!m) throw new AssistantError('response', `Respuesta inesperada de Ollama${json?.error ? `: ${json.error}` : ''}.`);
  const calls = (m.tool_calls || []).filter((t) => t.function?.name).map((t) => toCall(t.id, t.function.name, t.function.arguments));
  return {
    text: stripThink(m.content).trim(),
    calls,
    native: { provider: 'ollama', data: { role: 'assistant', content: m.content || '' } },
    stop: calls.length ? 'tool' : json.done_reason === 'length' ? 'length' : 'end',
    usage: { input: json.prompt_eval_count || 0, output: json.eval_count || 0 },
  };
}

// ---------- Construcción y lectura, por proveedor ----------
export const ADAPTERS = {
  gemini: { request: geminiRequest, parse: geminiParse },
  claude: { request: claudeRequest, parse: claudeParse },
  openai: { request: (o) => openaiRequest('openai', o), parse: (j) => openaiParse(j, 'openai'), fix: openaiFix },
  openrouter: { request: (o) => openaiRequest('openrouter', o), parse: (j) => openaiParse(j, 'openrouter'), fix: openaiFix },
  ollama: { request: ollamaRequest, parse: ollamaParse },
};

// ---------- Errores HTTP ----------
function providerMessage(body) {
  if (!body) return '';
  if (typeof body === 'string') return body.slice(0, 400);
  const e = body.error;
  if (typeof e === 'string') return e;
  return e?.message || body.message || JSON.stringify(body).slice(0, 400);
}

function retryAfterOf(headers, body) {
  const get = (n) => headers?.get?.(n);
  const ms = parseFloat(get('retry-after-ms'));
  if (Number.isFinite(ms)) return ms / 1000;
  const ra = get('retry-after');
  if (ra) {
    const n = parseFloat(ra);
    if (Number.isFinite(n)) return n;
    const d = Date.parse(ra);
    if (Number.isFinite(d)) return Math.max(0, (d - Date.now()) / 1000);
  }
  for (const d of body?.error?.details || []) {
    const m = /^([\d.]+)s$/.exec(String(d?.retryDelay || ''));
    if (m) return parseFloat(m[1]);
  }
  const m = /retry in ([\d.]+)\s*s/i.exec(providerMessage(body));
  return m ? parseFloat(m[1]) : null;
}

export function httpError(provider, status, body, headers) {
  const name = nameOf(provider);
  const details = providerMessage(body);
  const opts = { status, details, retryAfter: retryAfterOf(headers, body) };
  const err = (code, message) => new AssistantError(code, message, opts);
  const code = typeof body?.error === 'object' ? String(body.error.code ?? body.error.type ?? body.error.status ?? '') : '';
  if (/location is not supported|not available in your (country|region)|unsupported_country/i.test(details)) return err('request', `${name} no está disponible en tu país o región.`);
  if (/credit balance is too low|insufficient_quota|insufficient credits|requires more credits/i.test(`${code} ${details}`) || status === 402) {
    return err('quota', `Tu cuenta de ${name} no tiene saldo o cupo. Revisa la facturación en su página o cambia de proveedor en Ajustes (Gemini tiene nivel gratuito).`);
  }
  if (status === 401 || status === 403 || /api[_ ]?key[_ ]?invalid|api key not valid|invalid api key|incorrect api key|invalid x-api-key|authentication/i.test(details)) {
    return err('auth', `${name} rechazó la clave. Revisa en Ajustes del asistente que esté completa y sea de ${name}.`);
  }
  if (status === 404 || /model.*(not found|does not exist)|unknown model|no such model|is not found for api version/i.test(details)) {
    if (provider === 'ollama') {
      const model = /model ["'“]?([^"'”\s]+)/i.exec(details)?.[1];
      return err('model', `Ollama no tiene ${model ? `el modelo «${model}»` : 'ese modelo'}. Descárgalo con «ollama pull ${model || 'nombre'}» o elige otro en Ajustes.`);
    }
    return err('model', `${name} no encontró el modelo. Revisa su nombre en Ajustes del asistente (o pulsa «Ver modelos»).`);
  }
  if (/does not support tools|tools? (is|are) not supported|tool use is not supported|function calling is not (enabled|supported)|no endpoints found that support tool use/i.test(details)) {
    return err('model', 'El modelo elegido no sabe usar herramientas: elige otro en Ajustes del asistente.');
  }
  if (status === 413 || /too large|context length|maximum context|prompt is too long|too many tokens/i.test(details)) {
    return err('too_big', 'La conversación es demasiado larga para este modelo. Empieza una conversación nueva.');
  }
  if (status === 429) {
    const quotaIds = (body?.error?.details || []).flatMap((d) => (d?.violations || []).map((v) => v.quotaId || ''));
    if (quotaIds.some((q) => /PerDay/i.test(q)) || /per[ -]?day|daily/i.test(details)) {
      return err('quota', `Se agotó el cupo diario gratuito de ${name} para este modelo. Vuelve a intentarlo mañana o elige otro modelo en Ajustes (los «lite» tienen más cupo).`);
    }
    return err('rate', `${name} pide esperar: se alcanzó el límite de peticiones por minuto.`);
  }
  if (status === 408 || status === 529 || status >= 500) return err('server', `${name} está saturado o tuvo un problema (${status}).`);
  return err('request', `${name} rechazó la petición (${status})${details ? `: ${details}` : '.'}`);
}

function networkError(provider, err, baseUrl) {
  const details = String(err?.cause?.code || err?.cause?.message || err?.message || err);
  if (provider === 'ollama') {
    return new AssistantError('network', `No se pudo conectar con Ollama en ${ollamaBase(baseUrl)}. Comprueba que Ollama está abierto (si está en otro equipo, que acepte conexiones de la red).`, { details });
  }
  return new AssistantError('network', `No se pudo conectar con ${nameOf(provider)}. Revisa tu conexión a internet.`, { details });
}

// ---------- HTTP ----------
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(cancelled());
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
    };
    const stop = () => {
      done();
      reject(cancelled());
    };
    const timer = setTimeout(() => {
      done();
      resolve();
    }, ms);
    signal?.addEventListener('abort', stop, { once: true });
  });
}

async function send(doFetch, req, { signal, timeout, provider, baseUrl }) {
  const timer = AbortSignal.timeout(timeout);
  const sig = signal ? AbortSignal.any([signal, timer]) : timer;
  const fail = (err) => {
    if (signal?.aborted) return cancelled();
    if (timer.aborted) return new AssistantError('timeout', `${nameOf(provider)} tardó demasiado en responder (más de ${Math.round(timeout / 1000)} s).`);
    return networkError(provider, err, baseUrl);
  };
  let res;
  let text;
  try {
    res = await doFetch(req.url, { method: req.method || 'POST', headers: req.headers, body: req.body === undefined ? undefined : JSON.stringify(req.body), signal: sig });
    text = await res.text();
  } catch (err) {
    throw fail(err);
  }
  let body = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* respuesta en texto plano */
  }
  return { ok: res.ok, status: res.status, headers: res.headers, body };
}

const MAX_RETRIES = 3;
const MAX_WAIT = 65; // segundos: si el proveedor pide esperar más, se avisa en vez de esperar
const BACKOFF = [4, 10, 20];

/**
 * Un paso de la conversación: envía la historia y devuelve { text, calls, native, stop, usage }.
 * opts: { provider, model, key, baseUrl, system, messages, tools, images, maxTokens, signal, fetch, onWait, timeout }
 * Si el proveedor pide esperar (límite por minuto) o está saturado, espera y reintenta (avisa con onWait).
 */
export async function chat(opts) {
  const { provider, signal, onWait } = opts;
  const doFetch = opts.fetch || globalThis.fetch;
  const info = PROVIDER_MAP.get(provider);
  const adapter = ADAPTERS[provider];
  if (!info || !adapter) throw new AssistantError('request', `Proveedor desconocido: ${provider}`);
  if (info.needsKey && !opts.key) throw new AssistantError('nokey', `Falta la clave de ${info.name}: pégala en Ajustes del asistente.`);
  if (!String(opts.model || '').trim()) throw new AssistantError('model', 'Elige un modelo en Ajustes del asistente.');
  const timeout = opts.timeout || (provider === 'ollama' ? 600000 : 120000);
  const messages = prepareMessages(opts.messages || [], { images: opts.images !== false });
  const req = adapter.request({ ...opts, model: String(opts.model).trim(), messages, maxTokens: opts.maxTokens || 8192 });
  const fixed = new Set();
  let waits = 0;
  let confused = 0;
  for (;;) {
    if (signal?.aborted) throw cancelled();
    const res = await send(doFetch, req, { signal, timeout, provider, baseUrl: opts.baseUrl });
    if (res.ok) {
      const out = adapter.parse(res.body);
      if (!out.retry) return out;
      if (confused++ >= 1) throw new AssistantError('response', 'La IA no logró formular la acción. Vuelve a intentarlo o prueba con otro modelo.');
      continue;
    }
    const err = httpError(provider, res.status, res.body, res.headers);
    if (adapter.fix && err.code === 'request' && adapter.fix(req.body, err.details, fixed)) continue;
    if ((err.code === 'rate' || err.code === 'server') && waits < MAX_RETRIES) {
      const s = Math.max(0, err.retryAfter ?? BACKOFF[waits]);
      if (s <= MAX_WAIT) {
        waits++;
        onWait?.({ seconds: Math.ceil(s), reason: err.code, message: err.message });
        await sleep(s * 1000, signal);
        continue;
      }
      err.message += ` Vuelve a intentarlo en ${Math.ceil(s / 60)} min.`;
    }
    throw err;
  }
}

// ---------- Modelos disponibles para la clave ----------
async function mapLimit(items, limit, fn) {
  let i = 0;
  const worker = async () => {
    while (i < items.length) await fn(items[i++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

export async function listModels({ provider, key, baseUrl, signal, fetch: doFetch = globalThis.fetch }) {
  const info = PROVIDER_MAP.get(provider);
  if (!info) throw new AssistantError('request', `Proveedor desconocido: ${provider}`);
  if (info.needsKey && !key) throw new AssistantError('nokey', `Primero guarda la clave de ${info.name}.`);
  const base = provider === 'ollama' ? ollamaBase(baseUrl) : trimSlash(baseUrl) || info.baseUrl;
  const call = async (url, { method = 'GET', headers = {}, body } = {}) => {
    const r = await send(doFetch, { url, method, headers, body }, { signal, timeout: 30000, provider, baseUrl });
    if (!r.ok) throw httpError(provider, r.status, r.body, r.headers);
    return r.body || {};
  };
  const byId = (a, b) => a.id.localeCompare(b.id);
  if (provider === 'gemini') {
    const j = await call(`${base}/models?pageSize=1000`, { headers: { 'x-goog-api-key': key } });
    return (j.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map((m) => ({ id: String(m.name).replace(/^models\//, ''), label: m.displayName || '' }))
      .filter((m) => /^gemini-/.test(m.id) && !/(tts|image|live|transcribe|embedding|robotics|audio|computer-use)/.test(m.id))
      .sort(byId);
  }
  if (provider === 'claude') {
    const j = await call(`${base}/models?limit=100`, { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' } });
    return (j.data || []).map((m) => ({ id: m.id, label: m.display_name || '' }));
  }
  if (provider === 'openai') {
    const j = await call(`${base}/models`, { headers: { authorization: `Bearer ${key}` } });
    return (j.data || [])
      .map((m) => ({ id: m.id, label: '' }))
      .filter((m) => /^(gpt|o\d|chatgpt)/.test(m.id) && !/(audio|realtime|tts|transcribe|image|search|embedding|moderation|instruct)/.test(m.id))
      .sort(byId);
  }
  if (provider === 'openrouter') {
    const j = await call(`${base}/models`, { headers: { authorization: `Bearer ${key}` } });
    const price = (m) => parseFloat(m.pricing?.prompt || '0') * 1e6;
    return (j.data || [])
      .filter((m) => (m.supported_parameters || []).includes('tools'))
      .map((m) => ({ id: m.id, label: `${m.name || m.id} · ${price(m) ? `$${price(m).toFixed(2)}/M` : 'gratis'}`, price: price(m), images: (m.architecture?.input_modalities || []).includes('image') }))
      .sort((a, b) => a.price - b.price || byId(a, b));
  }
  // Ollama: los modelos descargados y qué sabe hacer cada uno (herramientas, imágenes).
  const j = await call(`${base}/api/tags`);
  const models = (j.models || []).map((m) => ({ id: m.name || m.model, label: m.details?.parameter_size || '' }));
  await mapLimit(models.slice(0, 30), 4, async (m) => {
    try {
      const s = await call(`${base}/api/show`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: { model: m.id } });
      if (Array.isArray(s.capabilities)) {
        m.tools = s.capabilities.includes('tools');
        m.images = s.capabilities.includes('vision');
      }
    } catch {
      /* versión de Ollama sin /api/show detallado */
    }
  });
  return models.sort(byId);
}
