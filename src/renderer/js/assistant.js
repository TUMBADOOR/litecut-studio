// Panel «Asistente»: chat con una IA (con la clave del propio usuario) que edita el proyecto con las mismas
// herramientas que el servidor MCP. Aquí corre el bucle del agente: la conversación se envía al proceso principal
// (que habla con el proveedor), se ejecutan las herramientas que pide la IA y se le devuelven los resultados, hasta
// que responde sin pedir más. Cada herramienta es un paso de deshacer. Este módulo se carga al abrir la pestaña.
import { store } from './store.js';
import { runLocal } from './ai-commands.js';
import { AI_TOOL_MAP } from '../shared/ai-tools.js';
import { PROVIDER_MAP } from '../shared/assistant-catalog.js';
import { h, btn, iconBtn, modal, toast } from './ui.js';
import { icon } from './icons.js';

const api = window.api;
const MAX_STEPS = 30; // llamadas a la IA por pedido
const KEEP_IMAGES = 3; // resultados con imágenes que se guardan completos en la conversación

const EXAMPLES = [
  'Corta los silencios y pon el título «Mi primer video» al principio.',
  'Pásalo a vertical 9:16 con el fondo desenfocado.',
  '¿Qué se ve en el segundo 5? Si el título tapa algo, súbelo.',
  'Aplica un filtro cálido a todos los clips y pon transiciones suaves entre ellos.',
];

const state = {
  messages: [], // conversación en formato neutral (ver main/assistant-providers.js)
  run: null, // { ac, id, steps, edits, undoTop, mixed } mientras la IA trabaja
  cfg: null, // configuración sin claves
  tokens: 0,
  projectChanged: false,
};
let seq = 0;
let panel = null;
const progressHandlers = new Map(); // callId → progreso de los análisis con FFmpeg

const emit = (detail) => window.dispatchEvent(new CustomEvent('litecut:assistant', { detail }));
const fmtInt = (n) => Math.round(n).toLocaleString('es');

// ---------- Texto de la IA (un poco de Markdown, sin HTML) ----------
function inline(s) {
  const out = [];
  const re = /\*\*([^*]+)\*\*|`([^`]+)`/g;
  let last = 0;
  let m;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(s.slice(last, m.index));
    out.push(m[1] ? h('b', {}, m[1]) : h('code', {}, m[2]));
    last = re.lastIndex;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}

function richText(text) {
  const frag = document.createDocumentFragment();
  let list = null;
  for (const line of String(text).replace(/\r/g, '').split('\n')) {
    const item = /^\s*([-*•]|\d+[.)])\s+(.*)$/.exec(line);
    if (item) {
      const tag = /\d/.test(item[1]) ? 'ol' : 'ul';
      if (!list || list.tagName.toLowerCase() !== tag) {
        list = h(tag);
        frag.append(list);
      }
      list.append(h('li', {}, ...inline(item[2])));
      continue;
    }
    list = null;
    if (!line.trim()) continue;
    const head = /^#{1,6}\s+(.*)$/.exec(line);
    frag.append(head ? h('p', {}, h('b', {}, ...inline(head[1]))) : h('p', {}, ...inline(line)));
  }
  return frag;
}

// ---------- Panel ----------
function createPanel({ openMcpDialog }) {
  const log = h('div', { class: 'asst-log' });
  const statusText = h('span', { class: 'txt' });
  const stopBtn = btn('Detener', { kind: 'small', icon: 'stop', title: 'Detener a la IA', onClick: () => stop() });
  const status = h('div', { class: 'asst-status' }, h('span', { class: 'spinner' }), statusText, stopBtn);
  const input = h('textarea', { class: 'asst-input', rows: 2, placeholder: 'Pide un cambio… (Enter envía, Mayús+Enter salto de línea)' });
  const sendBtn = h('button', { class: 'asst-send', type: 'button', title: 'Enviar (Enter)', html: icon('send', 16) });
  const chip = h('button', { class: 'asst-chip', type: 'button', title: 'Cambiar de proveedor o de modelo' });
  const tokensEl = h('span', { class: 'asst-tokens', title: 'Tokens usados en esta conversación (es lo que mide y cobra el proveedor)' });
  const newBtn = iconBtn('plus', 'Nueva conversación', () => reset());
  const setBtn = iconBtn('settings', 'Ajustes del asistente', () => openSettings());
  const root = h(
    'div',
    { class: 'asst' },
    h('div', { class: 'panel-head asst-head' }, h('h3', {}, 'Asistente'), h('div', { class: 'panel-head-x' }, newBtn, setBtn)),
    log,
    status,
    h('div', { class: 'asst-composer' }, input, sendBtn),
    h('div', { class: 'asst-foot' }, chip, tokensEl)
  );

  // ---------- Utilidades de la vista ----------
  // El chat sigue el final de la conversación, salvo que el usuario haya subido a leer algo anterior.
  let stick = true;
  log.addEventListener('scroll', () => (stick = log.scrollHeight - log.scrollTop - log.clientHeight < 40));
  const toBottom = () => (log.scrollTop = log.scrollHeight);
  const follow = () => stick && toBottom();
  const append = (el) => {
    log.append(el);
    follow();
    return el;
  };
  let waitTimer = null;
  const setStatus = (text) => {
    clearInterval(waitTimer);
    statusText.textContent = text;
  };
  const addNote = (text) => append(h('div', { class: 'asst-note' }, text));
  const autosize = () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(140, input.scrollHeight + 2)}px`;
  };

  function renderChip() {
    const cfg = state.cfg;
    if (!cfg) return;
    const info = PROVIDER_MAP.get(cfg.provider);
    const model = cfg.models[cfg.provider] || 'sin modelo';
    chip.replaceChildren(h('span', { html: icon(info.local ? 'monitor' : 'sparkles', 12) }), h('span', {}, `${info.label.replace(/ \(.*\)$/, '')} · ${model}`));
  }
  const renderTokens = () => (tokensEl.textContent = state.tokens ? `≈ ${fmtInt(state.tokens)} tokens` : '');
  const configured = () => {
    const cfg = state.cfg;
    if (!cfg) return false;
    const info = PROVIDER_MAP.get(cfg.provider);
    return (!info.needsKey || cfg.keys[cfg.provider]?.saved) && !!cfg.models[cfg.provider];
  };

  // ---------- Pantalla inicial (sin conversación) ----------
  function renderIntro() {
    if (state.messages.length || state.run) return;
    const cfg = state.cfg;
    const info = cfg ? PROVIDER_MAP.get(cfg.provider) : null;
    const wrap = h('div', { class: 'asst-intro' });
    wrap.append(h('div', { class: 'asst-intro-ic', html: icon('chat', 30) }), h('b', {}, 'Edita hablando con una IA'));
    if (cfg && !configured()) {
      wrap.append(
        h('p', {}, 'Escribe lo que quieres («corta los silencios y pon un título») y la IA lo hace en tu proyecto. Necesitas una clave de API de un proveedor: con Google Gemini es gratis.'),
        btn('Configurar el asistente', { kind: 'primary', icon: 'settings', onClick: () => openSettings() })
      );
    } else {
      wrap.append(h('p', {}, 'Pide cambios con tus palabras. La IA mira el proyecto, lo edita con las herramientas de LiteCut y cada paso se deshace con Ctrl+Z.'));
      const list = h('div', { class: 'asst-examples' });
      for (const text of EXAMPLES) {
        const b = h('button', { class: 'asst-example', type: 'button', title: 'Usar este ejemplo' }, text);
        b.addEventListener('click', () => {
          input.value = text;
          autosize();
          input.focus();
        });
        list.append(b);
      }
      wrap.append(list);
    }
    if (info) {
      wrap.append(
        h(
          'p',
          { class: 'hint' },
          info.local ? 'Con Ollama todo se queda en tu equipo o en tu red. ' : `Lo que escribes, los datos del proyecto que consulte la IA y los fotogramas que pida se envían a ${info.name}. `,
          h('a', { href: '#', onclick: (e) => (e.preventDefault(), openSettings()) }, 'Ajustes')
        )
      );
    }
    log.replaceChildren(wrap);
  }

  // ---------- Mensajes ----------
  const addUser = (text) => append(h('div', { class: 'asst-msg user' }, text));
  const addAssistant = (text) => append(h('div', { class: 'asst-msg ai' }, richText(text)));

  function addError(res) {
    const actions = [];
    if (['nokey', 'auth', 'model', 'quota', 'too_big'].includes(res.code)) actions.push(btn('Ajustes', { kind: 'small', icon: 'settings', onClick: () => openSettings() }));
    if (res.code === 'too_big') actions.push(btn('Nueva conversación', { kind: 'small', icon: 'plus', onClick: () => reset() }));
    else if (!['nokey', 'auth'].includes(res.code)) actions.push(btn('Reintentar', { kind: 'small', icon: 'rotate', onClick: () => retry() }));
    append(
      h(
        'div',
        { class: 'asst-error' },
        h('div', { class: 'asst-error-msg' }, h('span', { html: icon('alert', 14) }), h('span', {}, res.error || 'Error desconocido')),
        res.details ? h('details', {}, h('summary', {}, 'Detalles'), h('pre', {}, res.details)) : null,
        actions.length ? h('div', { class: 'asst-error-actions' }, ...actions) : null
      )
    );
  }

  function zoom(src) {
    modal({ title: 'Lo que vio la IA', body: h('img', { class: 'asst-zoom', src, alt: 'Fotograma' }), width: 760 });
  }

  // Fila de una herramienta: título en español, estado, resumen del resultado y, al abrirla, los detalles.
  function addToolRow(call) {
    const ic = h('span', { class: 'asst-tool-ic' }, h('span', { class: 'spinner' }));
    const sum = h('span', { class: 'asst-tool-sum' });
    const head = h('button', { class: 'asst-tool-head', type: 'button', title: 'Ver detalles' }, ic, h('span', { class: 'asst-tool-txt' }, h('b', {}, AI_TOOL_MAP.get(call.name)?.title || call.name), sum));
    const imgs = h('div', { class: 'asst-tool-imgs' });
    const details = h('div', { class: 'asst-tool-details' });
    const row = h('div', { class: 'asst-tool run', dataset: { tool: call.name } }, head, imgs, details);
    head.addEventListener('click', () => row.classList.toggle('open'));
    append(row);
    return { row, ic, sum, imgs, details };
  }

  function showProgress(r, p) {
    const pct = p.total ? Math.round((p.progress / p.total) * 100) : null;
    const msg = p.message ? `${p.message}${pct !== null && !/%/.test(p.message) ? ` ${pct} %` : ''}` : pct !== null ? `${pct} %` : '';
    r.sum.textContent = msg;
    if (msg) setStatus(msg);
  }

  function finishRow(r, call, content, isError) {
    r.row.classList.remove('run');
    r.row.classList.toggle('err', !!isError);
    r.ic.innerHTML = icon(isError ? 'alert' : 'check', 14);
    const text = content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    const first = (text.split('\n')[0] || '').trim();
    r.sum.textContent = first.length > 150 ? `${first.slice(0, 147)}…` : first;
    const args = call.args && Object.keys(call.args).length ? JSON.stringify(call.args, null, 1) : '';
    if (args) r.details.append(h('div', { class: 'asst-k' }, 'Lo que pidió la IA'), h('pre', {}, args.slice(0, 2000)));
    r.details.append(h('div', { class: 'asst-k' }, 'Resultado'), h('pre', {}, text.slice(0, 4000) || '—'));
    const pics = content.filter((c) => c.type === 'image' && c.data);
    for (const p of pics) {
      const img = h('img', { src: `data:${p.mimeType || 'image/png'};base64,${p.data}`, alt: 'Imagen que vio la IA', title: 'Lo que vio la IA (clic para ampliar)' });
      img.addEventListener('click', () => zoom(img.src));
      img.addEventListener('load', follow); // la imagen ocupa su alto al terminar de cargar
      r.imgs.append(img);
    }
    r.imgs.classList.toggle('grid', pics.length > 1);
  }

  // Tras un pedido que cambió el proyecto: cuántos cambios y un botón para deshacerlos todos.
  function addUndo(run) {
    if (!run.edits) return;
    const n = run.edits;
    const row = h('div', { class: 'asst-undo' }, h('span', {}, `${n === 1 ? '1 cambio' : `${n} cambios`} en el proyecto · Ctrl+Z deshace el último`));
    if (!run.mixed) {
      const top = run.undoTop;
      const b = btn(n === 1 ? 'Deshacer' : `Deshacer los ${n}`, {
        kind: 'small',
        icon: 'undo',
        onClick: () => {
          if (store.undoStack[store.undoStack.length - 1] !== top) {
            toast('Hubo otros cambios después: deshaz paso a paso con Ctrl+Z.', { timeout: 4000 });
            return;
          }
          for (let i = 0; i < n && store.undo(); i++);
          b.disabled = true;
          b.querySelector('span').textContent = 'Deshecho';
          toast(`Deshecho${n > 1 ? `s ${n} cambios` : ''}. Ctrl+Y los rehace.`, { timeout: 2500 });
        },
      });
      row.append(b);
    }
    append(row);
  }

  // ---------- Bucle del agente ----------
  function trimStoredImages() {
    let left = KEEP_IMAGES;
    for (let i = state.messages.length - 1; i >= 0; i--) {
      const m = state.messages[i];
      if (m.role !== 'tool') continue;
      const imgs = m.results.flatMap((r) => r.content.filter((c) => c.type === 'image' && c.data));
      if (!imgs.length) continue;
      if (left > 0) left--;
      else for (const c of imgs) c.data = null; // ya no se reenvía (el proceso principal pone un aviso en su lugar)
    }
  }

  const normalize = (res) => {
    const content = (res?.content || []).filter((c) => c && (c.type === 'text' || c.type === 'image'));
    return content.length ? content : [{ type: 'text', text: res?.isError ? 'Error.' : 'Hecho.' }];
  };

  async function runCall(call, run) {
    const r = addToolRow(call);
    setStatus(`${AI_TOOL_MAP.get(call.name)?.title || call.name}…`);
    if (call.argsError) {
      const content = [{ type: 'text', text: call.argsError }];
      finishRow(r, call, content, true);
      return { id: call.id, name: call.name, content, isError: true };
    }
    const callId = `${run.id}:${call.id}`; // texto: el progreso de los análisis llega por ai:localProgress
    const progress = (p) => showProgress(r, p);
    progressHandlers.set(callId, progress);
    const top = store.undoStack[store.undoStack.length - 1];
    let res;
    try {
      res = await runLocal(call.name, call.args, { signal: run.ac.signal, progress, callId });
    } finally {
      progressHandlers.delete(callId);
    }
    if (call.name === 'deshacer' || call.name === 'rehacer') run.mixed = true;
    else if (store.undoStack[store.undoStack.length - 1] !== top) {
      run.edits++;
      run.undoTop = store.undoStack[store.undoStack.length - 1];
    }
    const content = normalize(res);
    finishRow(r, call, content, res?.isError);
    return { id: call.id, name: call.name, content, ...(res?.isError ? { isError: true } : {}) };
  }

  async function runAgent() {
    const run = { ac: new AbortController(), id: '', steps: 0, edits: 0, undoTop: null, mixed: false };
    state.run = run;
    root.classList.add('running');
    sendBtn.disabled = true;
    newBtn.disabled = true;
    emit({ state: 'start' });
    let outcome = 'done';
    try {
      for (;;) {
        if (run.steps >= MAX_STEPS) {
          outcome = 'limit';
          break;
        }
        run.steps++;
        run.id = `asst-${++seq}`;
        setStatus(run.steps === 1 ? 'Pensando…' : `Pensando… (paso ${run.steps})`);
        const res = await api.assistant.chat({ id: run.id, messages: state.messages });
        if (run.ac.signal.aborted || res.code === 'cancelled') {
          outcome = 'stopped';
          break;
        }
        if (!res.ok) {
          addError(res);
          outcome = 'error';
          break;
        }
        const v = res.value;
        state.tokens += (v.usage?.input || 0) + (v.usage?.output || 0);
        renderTokens();
        const msg = { role: 'assistant', text: v.text || '', calls: v.calls || [], native: v.native };
        state.messages.push(msg);
        if (msg.text) addAssistant(msg.text);
        if (!msg.calls.length) {
          if (v.stop === 'length') addNote('La respuesta se cortó por su longitud. Escribe «sigue» para continuar.');
          else if (!msg.text) addNote('La IA no respondió nada. Prueba a decirlo de otra forma.');
          break;
        }
        const results = [];
        for (const call of msg.calls) {
          if (run.ac.signal.aborted) results.push({ id: call.id, name: call.name, content: [{ type: 'text', text: 'Cancelado: el usuario detuvo la tarea.' }], isError: true });
          else results.push(await runCall(call, run));
        }
        state.messages.push({ role: 'tool', results });
        trimStoredImages();
        if (run.ac.signal.aborted) {
          outcome = 'stopped';
          break;
        }
      }
    } catch (err) {
      addError({ error: err?.message || String(err) });
      outcome = 'error';
    } finally {
      // Las API exigen que cada llamada tenga su resultado y que a los resultados les siga una respuesta de la IA.
      const last = state.messages[state.messages.length - 1];
      if (last?.role === 'assistant' && last.calls?.length) {
        state.messages.push({ role: 'tool', results: last.calls.map((c) => ({ id: c.id, name: c.name, content: [{ type: 'text', text: 'No se ejecutó: la tarea se interrumpió.' }], isError: true })) });
      }
      if (state.messages[state.messages.length - 1]?.role === 'tool') {
        state.messages.push({ role: 'assistant', text: outcome === 'stopped' ? '(El usuario detuvo la tarea aquí.)' : '(La tarea se interrumpió aquí.)', calls: [], synthetic: true });
      }
      state.run = null;
      root.classList.remove('running');
      sendBtn.disabled = false;
      newBtn.disabled = false;
      setStatus('');
      if (outcome === 'stopped') addNote('Detenido.');
      if (outcome === 'limit') addNote(`La IA usó ${MAX_STEPS} pasos en este pedido. Escribe «sigue» para que continúe.`);
      addUndo(run);
      emit({ state: 'end', outcome, steps: run.steps, edits: run.edits });
    }
  }

  async function send(raw) {
    const text = String(raw || '').trim();
    if (!text || state.run) return;
    state.cfg = await api.assistant.config();
    renderChip();
    if (!configured()) {
      toast('Primero elige un proveedor y guarda tu clave.', { timeout: 3000 });
      openSettings();
      return;
    }
    if (!state.messages.length) log.replaceChildren();
    input.value = '';
    autosize();
    addUser(text);
    // Si se abrió otro proyecto, se avisa a la IA (sin mostrarlo) para que no use ids viejos.
    const note = state.projectChanged ? '[LiteCut: el usuario abrió otro proyecto; vuelve a usar ver_proyecto antes de editar.]\n' : '';
    state.projectChanged = false;
    state.messages.push({ role: 'user', text: note + text });
    await runAgent();
  }

  function retry() {
    if (state.run || !state.messages.length) return;
    if (state.messages[state.messages.length - 1]?.synthetic) state.messages.pop();
    const last = state.messages[state.messages.length - 1];
    if (last?.role === 'assistant') return; // la IA ya respondió: hay que escribir algo nuevo
    runAgent();
  }

  function stop() {
    const run = state.run;
    if (!run) return;
    run.ac.abort();
    api.assistant.cancel(run.id);
    setStatus('Deteniendo…');
  }

  function reset() {
    if (state.run) return;
    state.messages = [];
    state.tokens = 0;
    state.projectChanged = false;
    renderTokens();
    renderIntro();
    input.focus();
  }

  async function openSettings() {
    const { openAssistantSettings } = await import('./assistant-settings.js');
    openAssistantSettings({
      openMcpDialog,
      onChange: (cfg) => {
        state.cfg = cfg;
        renderChip();
        renderIntro();
      },
    });
  }

  // ---------- Eventos ----------
  sendBtn.addEventListener('click', () => send(input.value));
  input.addEventListener('input', autosize);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send(input.value);
    }
  });
  chip.addEventListener('click', () => openSettings());
  api.assistant.onWait(({ id, seconds, reason }) => {
    if (state.run?.id !== id) return;
    const label = reason === 'rate' ? 'El proveedor pide esperar (límite por minuto): reintento en' : 'El proveedor está saturado: reintento en';
    let left = seconds;
    setStatus(`${label} ${left} s…`);
    waitTimer = setInterval(() => {
      left = Math.max(0, left - 1);
      statusText.textContent = `${label} ${left} s…`;
      if (!left) clearInterval(waitTimer);
    }, 1000);
  });
  api.ai.onLocalProgress(({ callId, ...p }) => progressHandlers.get(callId)?.(p));
  store.on('load', () => {
    if (!state.messages.length) return;
    state.projectChanged = true;
    addNote('Se abrió otro proyecto: la IA lo mirará de nuevo antes de editar.');
  });

  api.assistant.config().then((cfg) => {
    state.cfg = cfg;
    renderChip();
    renderIntro();
  });
  renderIntro();

  return {
    el: root,
    // Al volver a la pestaña (el panel se vuelve a colocar y pierde el desplazamiento).
    shown() {
      requestAnimationFrame(toBottom);
    },
    focus: () => input.focus(),
    send,
  };
}

export function mountAssistant(actions) {
  panel ||= createPanel(actions);
  return panel;
}
