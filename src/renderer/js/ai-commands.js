// Capa de comandos para asistentes de IA: implementa las herramientas de shared/ai-tools.js sobre el store.
// Los cambios pasan por el historial (cada herramienta es un paso: Ctrl+Z lo deshace) y se ven al instante.
// La usan el servidor MCP local (a través del proceso principal) y, en el futuro, un asistente integrado.
// Cada comando devuelve contenido al estilo MCP: { content: [{ type: 'text', text } | { type: 'image', data, mimeType }] }.
import { store } from './store.js';
import { media } from './media.js';
import { overlayTrackFor } from './edit.js';
import * as ops from '../shared/ops.js';
import { AI_TOOL_MAP, validateArgs } from '../shared/ai-tools.js';
import { ASPECTS, MIN_CLIP, DEFAULT_TEXT_DURATION, createClip, clipEnd, mainTrack, trackClips, trackLabel, isVisual, projectDuration, defaultAdjust, defaultText, snapToFrame, clone } from '../shared/model.js';
import { FILTER_PRESETS, ADJUST_FIELDS } from '../shared/effects.js';
import { TEXT_PRESETS, renderTextCanvas, ensureFont } from './text-render.js';
import { FORMATS, renderTextAssets } from './export-dialog.js';
import { h, btn, toast } from './ui.js';

const api = window.api;
let ctx = null; // { player, timeline, beforeEdit(), onActivity(info), onSaved() }

// ---------- Utilidades ----------
const r3 = (v) => Math.round((Number(v) || 0) * 1000) / 1000;
const sec = (v) => `${r3(v)} s`;
const fps = () => store.project.settings.fps || 30;
const even = (v) => Math.max(2, Math.round(v / 2) * 2);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const result = (text, data) => ({ content: [{ type: 'text', text: data === undefined ? text : `${text}\n${JSON.stringify(data)}` }] });

function needClip(id) {
  const c = store.getClip(id);
  if (!c) throw new Error(`No existe el clip «${id}». Usa ver_proyecto para ver los ids.`);
  return c;
}

function needEditable(id) {
  const c = needClip(id);
  if (store.getTrack(c.trackId)?.locked) throw new Error(`El clip «${id}» está en una pista bloqueada.`);
  return c;
}

function needMedia(id) {
  const m = store.getMedia(id);
  if (!m) throw new Error(`No existe el medio «${id}». Usa ver_proyecto o importar_medios.`);
  if (m.missing) throw new Error(`No se encuentra el archivo de «${m.name}» (${m.path}).`);
  return m;
}

function findTrackRef(p, ref) {
  const byId = ops.findTrack(p, ref);
  if (byId) return byId;
  const label = String(ref).trim().toUpperCase();
  const t = p.tracks.find((x) => trackLabel(p, x) === label);
  if (t) return t;
  throw new Error(`No existe la pista «${ref}». Pistas: ${p.tracks.map((x) => trackLabel(p, x)).join(', ')} (o «nueva»).`);
}

// Pista para un clip de cierto tipo ('video' o 'audio'); «nueva» la crea (solo dentro de change()).
function trackFor(p, ref, kind) {
  if (String(ref).toLowerCase() === 'nueva') return ops.addTrack(p, kind);
  const t = findTrackRef(p, ref);
  if (t.kind !== kind) throw new Error(`La pista ${trackLabel(p, t)} es de ${t.kind === 'audio' ? 'audio' : 'video'}: este clip va en una pista de ${kind === 'audio' ? 'audio' : 'video'}.`);
  if (t.locked) throw new Error(`La pista ${trackLabel(p, t)} está bloqueada.`);
  return t;
}

function color(v, name) {
  const s = String(v).trim().toLowerCase();
  let m = /^#?([0-9a-f]{6})$/.exec(s);
  if (m) return `#${m[1]}`;
  m = /^#?([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(s);
  if (m) return `#${m[1]}${m[1]}${m[2]}${m[2]}${m[3]}${m[3]}`;
  const named = { blanco: '#ffffff', white: '#ffffff', negro: '#000000', black: '#000000', rojo: '#ff3b30', red: '#ff3b30', amarillo: '#ffd400', yellow: '#ffd400', verde: '#34c759', green: '#34c759', azul: '#2f80ff', blue: '#2f80ff', naranja: '#ff9500', orange: '#ff9500', rosa: '#ff4d8d', pink: '#ff4d8d', morado: '#8b5cf6', purple: '#8b5cf6', gris: '#8e8e93', gray: '#8e8e93', celeste: '#5ac8fa', cyan: '#00e5ff' };
  if (named[s]) return named[s];
  throw new Error(`«${name}» debe ser un color en hexadecimal, p. ej. #ffffff.`);
}

// Rutas (sin el módulo path de Node).
const isAbsolute = (p) => /^[a-zA-Z]:[\\/]/.test(p) || /^\\\\/.test(p) || p.startsWith('/');
const sepOf = (p) => (p.includes('\\') ? '\\' : '/');
const joinPath = (dir, name) => `${dir.replace(/[\\/]+$/, '')}${sepOf(dir)}${name}`;
const safeName = (s) => String(s).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim().slice(0, 100) || 'Mi video';
const samePath = (a, b) => !!a && !!b && (window.api.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

function cleanPath(p) {
  let s = String(p).trim().replace(/^["']|["']$/g, '');
  if (/^file:\/\//i.test(s)) {
    s = decodeURIComponent(s.replace(/^file:\/\/\/?/i, ''));
    if (!/^[a-zA-Z]:/.test(s)) s = `/${s}`;
  }
  return s;
}

async function uniquePath(file) {
  const dot = file.lastIndexOf('.');
  const base = file.slice(0, dot);
  const ext = file.slice(dot);
  for (let i = 1; i < 500; i++) {
    const cand = i === 1 ? file : `${base} (${i})${ext}`;
    if (!(await api.fs.exists([cand]))[0]) return cand;
  }
  return `${base} ${Date.now().toString(36)}${ext}`;
}

// ---------- Descripciones para la IA ----------
function mediaState(m) {
  if (m.missing) return 'falta el archivo';
  const st = media.getStatus(m.id);
  if (st.state === 'checking') return 'preparando';
  if (st.state === 'proxy') return `convirtiendo ${Math.round((st.progress || 0) * 100)} %`;
  if (st.state === 'error') return `error: ${st.error || ''}`;
  return st.optimizing ? 'listo (creando copia ligera)' : 'listo';
}

function describeMedia(m) {
  const o = { id: m.id, nombre: m.name, tipo: m.kind, ruta: m.path };
  if (m.kind !== 'image') o.duracion = r3(m.duration);
  if (m.width) Object.assign(o, { ancho: m.width, alto: m.height });
  if (m.kind === 'video') o.audio = !!m.hasAudio;
  if (m.fps) o.fps = r3(m.fps);
  o.estado = mediaState(m);
  return o;
}

function describeClip(p, c) {
  const tr = ops.findTrack(p, c.trackId);
  const m = c.mediaId ? ops.findMedia(p, c.mediaId) : null;
  const o = { id: c.id, tipo: c.type, pista: tr ? trackLabel(p, tr) : '?', inicio: r3(c.start), fin: r3(clipEnd(c)), duracion: r3(c.duration) };
  if (m) Object.assign(o, { medio: m.id, nombre: m.name });
  if (c.type === 'video' || c.type === 'audio') o.entrada = r3(c.in);
  if ((c.speed || 1) !== 1) o.velocidad = r3(c.speed);
  if (c.type === 'text') o.texto = c.text.content;
  if (c.muted) o.silenciado = true;
  if ((c.volume ?? 1) !== 1) o.volumen = r3(c.volume);
  if (c.transitionIn) o.transicion = { tipo: c.transitionIn.type, duracion: r3(c.transitionIn.duration) };
  if (c.filter && c.filter !== 'none') o.filtro = c.filter;
  if (c.bgFill === 'blur') o.fondo = 'desenfoque';
  if (c.linkedTo) o.audio_de = c.linkedTo;
  if (c.animIn?.type && c.animIn.type !== 'none') o.animacion_entrada = c.animIn.type;
  if (c.animOut?.type && c.animOut.type !== 'none') o.animacion_salida = c.animOut.type;
  const t = c.transform;
  if (t && (t.x || t.y || t.scale !== 1 || t.rotation || t.opacity !== 1)) o.transformacion = { x: r3(t.x), y: r3(t.y), escala: r3(t.scale), rotacion: r3(t.rotation), opacidad: r3(t.opacity) };
  return o;
}

function orderedClips(p) {
  const order = new Map(p.tracks.map((t, i) => [t.id, i]));
  return [...p.clips].sort((a, b) => order.get(a.trackId) - order.get(b.trackId) || a.start - b.start);
}

// ---------- Cambios con historial ----------
function prepareEdit() {
  ctx?.beforeEdit?.();
}

// Aplica fn al proyecto como un paso de deshacer. Si fn falla a medias, el proyecto vuelve a como estaba.
function change(fn) {
  prepareEdit();
  const before = store.snapshot();
  try {
    return store.mutate(fn);
  } catch (err) {
    store.applySnapshot(before);
    store.version++;
    store.emit('change', { kind: 'live' });
    throw err;
  }
}

function show(ids, t) {
  if (ids?.length) store.select(ids);
  if (t !== undefined && ctx?.player) ctx.player.seek(t);
}

// ---------- Análisis (proceso principal, FFmpeg) ----------
async function silencesOf(m, opts, callId) {
  const r = await api.ai.silences({ file: m.path, noise: opts.noise, minDuration: opts.minDuration, duration: m.duration, callId });
  if (!r.ok) throw new Error(`«${m.name}»: ${r.error}`);
  return r.value;
}

function soundClipsOfMain(p) {
  const main = mainTrack(p);
  if (!main) return [];
  return trackClips(p, main.id).filter((c) => (c.type === 'video' || c.type === 'audio') && ops.findMedia(p, c.mediaId)?.hasAudio);
}

function defaultVideoMedia() {
  const vids = store.project.media.filter((m) => m.kind === 'video');
  if (vids.length === 1) return needMedia(vids[0].id);
  throw new Error(vids.length ? 'Indica clip o medio (hay varios videos).' : 'No hay videos importados.');
}

// ---------- Exportación ----------
let job = null;

function describeJob(j) {
  if (j.running) {
    const parts = [`Exportando: ${Math.round(j.percent * 100)} %`];
    if (j.speed) parts.push(`${j.speed.toFixed(1)}× tiempo real`);
    if (j.eta !== null && j.eta !== undefined) parts.push(`quedan ~${Math.max(1, Math.round(j.eta))} s`);
    return result(`${parts.join(', ')}. Sigue en curso: consulta estado_exportacion más tarde.`, { archivo: j.output, progreso: r3(j.percent) });
  }
  const r = j.result;
  if (r?.ok) {
    const hw = r.encoder && r.encoder !== 'cpu' ? ` usando la tarjeta gráfica (${r.encoder})` : '';
    return result(`Exportación terminada en ${Math.round(r.seconds)} s${hw}: ${r.output}`, { archivo: r.output, duracion_video: r3(j.duration), formato: j.format });
  }
  if (r?.cancelled) return result('La exportación se canceló.');
  return { content: [{ type: 'text', text: `No se pudo exportar: ${r?.error?.message || 'error desconocido'}${r?.error?.details ? `\n${r.error.details}` : ''}` }], isError: true };
}

function waitFor(promise, seconds, signal) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, seconds * 1000);
    signal?.addEventListener('abort', finish, { once: true });
    promise.then(finish, finish);
  });
}

async function waitJob(j, seconds, { signal, progress } = {}) {
  if (!j.running || seconds <= 0) return;
  if (progress) j.listeners.add(progress);
  try {
    await waitFor(j.promise, seconds, signal);
  } finally {
    if (progress) j.listeners.delete(progress);
  }
}

let banner = null;
function updateBanner(j) {
  if (!j.running) {
    banner?.remove();
    banner = null;
    return;
  }
  if (!banner) {
    const cancel = btn('Cancelar', { kind: 'small', onClick: () => api.exporter.cancel() });
    banner = h('div', { class: 'proc-banner ai-export' }, h('span', { class: 'spinner' }), h('span', { class: 'txt' }), cancel);
    document.body.append(banner);
  }
  banner.querySelector('.txt').textContent = `Exportando (pedido por la IA)… ${Math.round(j.percent * 100)} %`;
}

// ---------- Herramientas ----------
const handlers = {
  ver_proyecto() {
    const p = store.project;
    const s = p.settings;
    const main = mainTrack(p);
    const dur = projectDuration(p);
    const data = {
      nombre: p.name,
      archivo: store.projectPath,
      guardado: !store.dirty,
      lienzo: { ancho: s.width, alto: s.height, formato: s.aspect, fps: s.fps, fondo: s.background },
      duracion: r3(dur),
      cursor: r3(ctx.player.time),
      pistas: p.tracks.map((t) => {
        const o = { nombre: trackLabel(p, t), id: t.id, tipo: t.kind };
        if (t.id === main?.id) o.principal = true;
        if (t.hidden) o.oculta = true;
        if (t.muted) o.silenciada = true;
        if (t.locked) o.bloqueada = true;
        return o;
      }),
      clips: orderedClips(p).map((c) => describeClip(p, c)),
      medios: p.media.map(describeMedia),
      seleccion: [...store.selection],
      puede_deshacer: store.canUndo,
      puede_rehacer: store.canRedo,
    };
    const text = `Proyecto «${p.name}»: lienzo ${s.width}×${s.height} (${s.aspect}) a ${s.fps} fps, duración ${sec(dur)}, ${p.clips.length} clips en ${p.tracks.length} pistas, ${p.media.length} medios.`;
    return result(text, data);
  },

  ver_clip({ clip }) {
    const p = store.project;
    const c = needClip(clip);
    const props = clone(c);
    return result(`Clip ${c.id} (${c.type}) de ${sec(c.start)} a ${sec(clipEnd(c))}. «propiedades» usa los nombres internos del proyecto.`, { resumen: describeClip(p, c), propiedades: props });
  },

  async importar_medios({ rutas, agregar }) {
    prepareEdit();
    const errors = [];
    const paths = [];
    for (const raw of rutas) {
      const p = cleanPath(raw);
      if (!isAbsolute(p)) errors.push({ path: p, message: 'La ruta debe ser absoluta (p. ej. C:\\Users\\…\\video.mp4).' });
      else paths.push(p);
    }
    const exists = paths.length ? await api.fs.exists(paths) : [];
    const ok = paths.filter((p, i) => exists[i] || (errors.push({ path: p, message: 'El archivo no existe.' }), false));
    const added = await media.importPaths(ok, { errors });
    let clips = [];
    if (agregar && added.length) {
      clips = change((p) => added.filter((m) => !m.missing).map((m) => ops.addMediaClip(p, m, { t: 0, imageDuration: 5 })));
      show(clips.map((c) => c.id));
      ctx.timeline?.fitZoom();
    }
    const p = store.project;
    const data = { medios: added.map(describeMedia) };
    if (clips.length) data.clips = clips.map((c) => describeClip(p, c));
    if (errors.length) data.errores = errors.map((e) => ({ ruta: e.path, error: e.message }));
    const text = `${added.length ? `Importado(s) ${added.length} archivo(s)` : 'No se importó ningún archivo'}${clips.length ? ` y añadido(s) ${clips.length} clip(s)` : ''}.${errors.length ? ` ${errors.length} con errores.` : ''}`;
    if (!added.length && errors.length) return { ...result(text, data), isError: true };
    return result(text, data);
  },

  agregar_clip({ medio, inicio, pista, entrada, duracion }) {
    const m = needMedia(medio);
    if (entrada !== undefined && m.kind !== 'image' && entrada >= m.duration - MIN_CLIP) throw new Error(`entrada (${sec(entrada)}) supera la duración del archivo (${sec(m.duration)}).`);
    const kind = m.kind === 'audio' ? 'audio' : 'video';
    const clip = change((p) => {
      const trackId = pista ? trackFor(p, pista, kind).id : null;
      const start = inicio === undefined ? null : snapToFrame(inicio, fps());
      const c = ops.addMediaClip(p, m, { t: start ?? 0, trackId, start, imageDuration: 5 });
      if (entrada !== undefined && m.kind !== 'image') {
        c.in = entrada;
        ops.setDuration(p, c.id, duracion ?? m.duration - entrada);
      } else if (duracion !== undefined) ops.setDuration(p, c.id, duracion);
      return c;
    });
    show([clip.id], clip.start);
    return result(`Añadido «${m.name}» en ${trackLabel(store.project, store.getTrack(clip.trackId))} de ${sec(clip.start)} a ${sec(clipEnd(clip))}.`, describeClip(store.project, clip));
  },

  dividir({ tiempo, clip }) {
    const p = store.project;
    const t = snapToFrame(tiempo, fps());
    const inside = (c) => t > c.start + MIN_CLIP / 2 && t < clipEnd(c) - MIN_CLIP / 2;
    let targets;
    if (clip) {
      const c = needEditable(clip);
      if (!inside(c)) throw new Error(`${sec(t)} no está dentro del clip (va de ${sec(c.start)} a ${sec(clipEnd(c))}).`);
      targets = [c];
    } else {
      targets = p.clips.filter((c) => inside(c) && !store.getTrack(c.trackId)?.locked);
      const ids = new Set(targets.map((c) => c.id));
      targets = targets.filter((c) => !(c.type === 'audio' && c.linkedTo && ids.has(c.linkedTo))); // se divide con su video
    }
    if (!targets.length) throw new Error(`No hay ningún clip que dividir en ${sec(t)}.`);
    const ids = targets.map((c) => c.id);
    const created = change((pp) => ids.map((id) => ops.splitClip(pp, id, t)).filter(Boolean));
    show(created.map((c) => c.id), t);
    return result(`Dividido en ${sec(t)}: ${created.length} parte(s) nueva(s).`, { partes_nuevas: created.map((c) => describeClip(store.project, c)) });
  },

  recortar_clip({ clip, quitar_inicio, quitar_final, nuevo_inicio, nuevo_fin }) {
    const c = needEditable(clip);
    let head = quitar_inicio ?? 0;
    let tail = quitar_final ?? 0;
    if (nuevo_inicio !== undefined) head = nuevo_inicio - c.start;
    if (nuevo_fin !== undefined) tail = clipEnd(c) - nuevo_fin;
    if (!head && !tail) throw new Error('Indica quitar_inicio, quitar_final, nuevo_inicio o nuevo_fin.');
    if (head + tail > c.duration - MIN_CLIP) throw new Error(`El clip dura ${sec(c.duration)}: no se puede quitar tanto. Para borrarlo usa eliminar_clips.`);
    const before = { start: c.start, end: clipEnd(c) };
    change((p) => ops.trimClip(p, c.id, { head, tail }));
    const now = store.getClip(c.id);
    show([c.id], now.start);
    return result(`Recortado: antes de ${sec(before.start)} a ${sec(before.end)}, ahora de ${sec(now.start)} a ${sec(clipEnd(now))}.`, describeClip(store.project, now));
  },

  mover_clip({ clip, inicio, pista }) {
    const c = needEditable(clip);
    const kind = ops.trackKindFor(c);
    change((p) => {
      const tr = pista ? trackFor(p, pista, kind) : ops.findTrack(p, c.trackId);
      ops.moveClips(p, [{ id: c.id, start: Math.max(0, snapToFrame(inicio, fps())), trackId: tr.id }]);
    });
    const now = store.getClip(c.id);
    show([c.id], now.start);
    const p = store.project;
    return result(`Movido a ${trackLabel(p, store.getTrack(now.trackId))}, de ${sec(now.start)} a ${sec(clipEnd(now))}.`, describeClip(p, now));
  },

  eliminar_clips({ clips, cerrar_hueco }) {
    const list = clips.map(needEditable);
    const ids = list.map((c) => c.id);
    change((p) => ops.deleteClips(p, ids, { ripple: !!cerrar_hueco }));
    store.clearSelection();
    return result(`Eliminado(s) ${ids.length} clip(s)${cerrar_hueco ? ' cerrando el hueco' : ''}. Duración del proyecto: ${sec(projectDuration(store.project))}.`);
  },

  eliminar_tramo({ inicio, fin, pista }) {
    if (!(fin - inicio > 0.01)) throw new Error('fin debe ser mayor que inicio.');
    const p = store.project;
    const tr = pista ? findTrackRef(p, pista) : mainTrack(p);
    if (!tr) throw new Error('No hay pista principal.');
    if (tr.locked) throw new Error(`La pista ${trackLabel(p, tr)} está bloqueada.`);
    const before = projectDuration(p);
    const removed = change((pp) => ops.removeRange(pp, tr.id, inicio, fin));
    show([], inicio);
    return result(`Quitado el tramo de ${sec(inicio)} a ${sec(fin)} de ${trackLabel(store.project, tr)} (${sec(removed)}). Duración: ${sec(before)} → ${sec(projectDuration(store.project))}.`);
  },

  cambiar_velocidad({ clip, velocidad }) {
    const c = needEditable(clip);
    if (c.type !== 'video' && c.type !== 'audio') throw new Error('Solo los clips de video o audio tienen velocidad.');
    change((p) => ops.setSpeed(p, c.id, velocidad));
    const now = store.getClip(c.id);
    show([c.id]);
    return result(`Velocidad ${r3(now.speed)}×: el clip ahora dura ${sec(now.duration)} (de ${sec(now.start)} a ${sec(clipEnd(now))}).`, describeClip(store.project, now));
  },

  ajustar_clip(a) {
    const ids = a.clips?.length ? a.clips : a.clip ? [a.clip] : [];
    if (!ids.length) throw new Error('Indica clip o clips.');
    const list = ids.map(needEditable);
    const main = mainTrack(store.project);
    if (a.fondo && list.some((c) => c.trackId !== main?.id || (c.type !== 'video' && c.type !== 'image'))) throw new Error('El fondo desenfocado solo se aplica a videos o fotos de la pista principal.');
    const changed = new Set();
    change((p) => {
      for (const c0 of list) {
        const c = ops.findClip(p, c0.id);
        const set = (key, fn) => {
          if (a[key] === undefined) return;
          fn(a[key]);
          changed.add(key);
        };
        set('volumen', (v) => (c.volume = v));
        set('silenciar', (v) => {
          if (v) c.muted = true;
          else if (c.type === 'video') ops.reattachAudio(p, c.id); // devuelve el audio separado
          else c.muted = false;
        });
        set('fundido_entrada', (v) => (c.fadeIn = v));
        set('fundido_salida', (v) => (c.fadeOut = v));
        set('x', (v) => (c.transform.x = Math.round(v)));
        set('y', (v) => (c.transform.y = Math.round(v)));
        set('escala', (v) => (c.transform.scale = v));
        set('rotacion', (v) => (c.transform.rotation = v));
        set('opacidad', (v) => (c.transform.opacity = v));
        set('voltear_horizontal', (v) => (c.transform.flipH = v));
        set('voltear_vertical', (v) => (c.transform.flipV = v));
        set('recorte', (v) => {
          const k = { izquierda: 'l', arriba: 't', derecha: 'r', abajo: 'b' };
          for (const [es, en] of Object.entries(k)) if (v[es] !== undefined) c.crop[en] = v[es];
        });
        set('mascara', (v) => (c.mask = v));
        set('fondo', (v) => (c.bgFill = v === 'desenfoque' ? 'blur' : 'none'));
        set('animacion_entrada', (v) => (c.animIn.type = v));
        set('animacion_salida', (v) => (c.animOut.type = v));
        set('duracion_animacion', (v) => {
          c.animIn.duration = v;
          c.animOut.duration = v;
        });
        set('ken_burns', (v) => (c.kenburns = v));
        set('duracion', (v) => ops.setDuration(p, c.id, v));
      }
    });
    if (!changed.size) throw new Error('No se indicó ninguna propiedad para cambiar.');
    show(list.map((c) => c.id));
    const p = store.project;
    return result(`Ajustado(s) ${list.length} clip(s): ${[...changed].join(', ')}.`, { clips: list.map((c) => describeClip(p, store.getClip(c.id))) });
  },

  async agregar_texto(a) {
    const p = store.project;
    const draft = createClip('text', { name: 'Texto', duration: a.duracion ?? DEFAULT_TEXT_DURATION });
    const preset = TEXT_PRESETS.find((x) => x.id === (a.estilo || 'title'));
    draft.name = preset.name;
    Object.assign(draft.text, clone(preset.text));
    if (preset.x) draft.transform.x = preset.x * (p.settings.width / 1920);
    if (preset.y) draft.transform.y = preset.y * (p.settings.height / 1080);
    applyTextArgs(draft, { ...a, estilo: undefined });
    await fitText(draft, a);
    const start = snapToFrame(a.inicio ?? ctx.player.time, fps());
    const clip = change((pp) => {
      const tr = overlayTrackFor(pp, start, start + draft.duration, null);
      draft.trackId = tr.id;
      pp.clips.push(draft);
      draft.start = -1e9;
      ops.placeClip(pp, draft, tr.id, start);
      return draft;
    });
    show([clip.id], clip.start + Math.min(0.5, clip.duration / 2));
    const now = store.getClip(clip.id);
    return result(`Texto añadido en ${trackLabel(store.project, store.getTrack(now.trackId))} de ${sec(now.start)} a ${sec(clipEnd(now))} (tamaño ${Math.round(now.text.size)} px). Revísalo con ver_fotograma.`, describeClip(store.project, now));
  },

  async editar_texto(a) {
    const c = needEditable(a.clip);
    if (c.type !== 'text') throw new Error('Ese clip no es un texto.');
    const draft = clone(c);
    if (a.estilo) {
      const preset = TEXT_PRESETS.find((x) => x.id === a.estilo);
      const content = draft.text.content;
      draft.text = Object.assign(defaultText(), clone(preset.text), { content });
    }
    applyTextArgs(draft, a);
    if (['texto', 'estilo', 'fuente', 'grosor', 'mayusculas', 'contorno', 'posicion'].some((k) => a[k] !== undefined)) await fitText(draft, a);
    change((p) => {
      const x = ops.findClip(p, c.id);
      x.text = draft.text;
      x.transform = draft.transform;
      x.animIn = draft.animIn;
      x.animOut = draft.animOut;
    });
    show([c.id], c.start + Math.min(0.5, c.duration / 2));
    return result('Texto actualizado. Revísalo con ver_fotograma.', describeClip(store.project, store.getClip(c.id)));
  },

  poner_transicion({ clip, tiempo, tipo = 'fade', duracion = 0.6 }) {
    const p = store.project;
    const main = mainTrack(p);
    let b = clip ? needEditable(clip) : null;
    if (!b) {
      if (tiempo === undefined) throw new Error('Indica clip (el que entra) o tiempo.');
      b = ops.junctionNear(p, tiempo);
      if (!b) throw new Error('No hay dos clips seguidos en la pista principal.');
    }
    const list = main ? trackClips(p, main.id) : [];
    const i = list.findIndex((c) => c.id === b.id);
    if (!main || b.trackId !== main.id || !isVisual(b) || i < 1 || !isVisual(list[i - 1])) {
      throw new Error('Las transiciones van entre dos clips seguidos de la pista principal: indica el clip de después de la unión.');
    }
    change((pp) => ops.applyTransition(pp, b.id, tipo, duracion));
    const now = store.getClip(b.id);
    store.selectTransition(b.id);
    ctx.player.seek(Math.max(0, now.start - 0.3));
    return result(`Transición «${tipo}» de ${sec(now.transitionIn?.duration)} entre ${list[i - 1].id} y ${b.id} (desde ${sec(now.start)}). Duración del proyecto: ${sec(projectDuration(store.project))}.`);
  },

  quitar_transicion({ clip }) {
    const c = needEditable(clip);
    if (!c.transitionIn) throw new Error('Ese clip no tiene transición de entrada.');
    change((p) => ops.removeTransition(p, c.id));
    show([c.id]);
    return result(`Transición quitada. Duración del proyecto: ${sec(projectDuration(store.project))}.`);
  },

  aplicar_filtro({ clips, filtro, ajustes }) {
    if (!filtro && !ajustes) throw new Error('Indica filtro o ajustes.');
    const p = store.project;
    const list = clips?.length ? clips.map(needEditable) : p.clips.filter((c) => (c.type === 'video' || c.type === 'image') && !store.getTrack(c.trackId)?.locked);
    const targets = list.filter((c) => c.type === 'video' || c.type === 'image');
    if (!targets.length) throw new Error('No hay clips de video o foto a los que aplicar el filtro.');
    const keys = { brillo: 'brightness', contraste: 'contrast', saturacion: 'saturation', tono: 'hue', temperatura: 'temperature', matiz: 'tint', sepia: 'sepia', blanco_negro: 'grayscale', desenfoque: 'blur', vineta: 'vignette' };
    const preset = filtro ? FILTER_PRESETS.find((f) => f.id === filtro) : null;
    change((pp) => {
      for (const t of targets) {
        const c = ops.findClip(pp, t.id);
        if (preset) {
          c.adjust = { ...defaultAdjust(), ...preset.adjust };
          c.filter = preset.id;
        }
        for (const [es, en] of Object.entries(keys)) {
          if (ajustes?.[es] === undefined) continue;
          const f = ADJUST_FIELDS.find((x) => x.key === en);
          c.adjust[en] = clamp(ajustes[es], f.min, f.max);
        }
      }
    });
    show(targets.map((c) => c.id));
    return result(`${preset ? `Filtro «${preset.name}»` : 'Ajustes de color'} aplicado(s) a ${targets.length} clip(s).`);
  },

  configurar_proyecto({ formato, ancho, alto, fps: newFps, fondo, nombre, relleno }) {
    const bg = fondo !== undefined ? color(fondo, 'fondo') : null;
    if (newFps !== undefined && ![24, 25, 30, 50, 60].includes(newFps)) throw new Error('fps debe ser 24, 25, 30, 50 o 60.');
    if (formato === undefined && ancho === undefined && alto === undefined && newFps === undefined && !bg && nombre === undefined && !relleno) throw new Error('No se indicó nada que cambiar.');
    change((p) => {
      const s = p.settings;
      if (formato) {
        const a = ASPECTS.find((x) => x.id === formato);
        Object.assign(s, { width: a.w, height: a.h, aspect: a.id });
      }
      if (ancho !== undefined || alto !== undefined) {
        s.width = even(ancho ?? s.width);
        s.height = even(alto ?? s.height);
        s.aspect = ASPECTS.find((x) => x.w === s.width && x.h === s.height)?.id || 'custom';
      }
      if (newFps !== undefined) s.fps = newFps;
      if (bg) s.background = bg;
      if (nombre !== undefined) p.name = String(nombre).trim() || 'Proyecto sin título';
      if (relleno) {
        const main = mainTrack(p);
        for (const c of p.clips) if (c.trackId === main?.id && (c.type === 'video' || c.type === 'image')) c.bgFill = relleno === 'desenfoque' ? 'blur' : 'none';
      }
    });
    const s = store.project.settings;
    return result(`Proyecto: lienzo ${s.width}×${s.height} (${s.aspect}), ${s.fps} fps, fondo ${s.background}${relleno ? `, relleno ${relleno}` : ''}. Revisa el encuadre con ver_fotograma.`);
  },

  async ver_fotograma({ tiempo, ancho = 512, formato = 'png' }) {
    const p = store.project;
    if (!p.clips.length) throw new Error('El proyecto está vacío: no hay nada que ver.');
    const dur = projectDuration(p);
    const t = clamp(tiempo ?? ctx.player.time, 0, Math.max(0, dur - 1 / fps()));
    const scale = Math.min(1, ancho / p.settings.width);
    const still = await ctx.player.stillAt(t, scale);
    const mimeType = formato === 'jpeg' ? 'image/jpeg' : 'image/png';
    const data = still.canvas.toDataURL(mimeType, 0.85).split(',')[1];
    const note = still.pending.length ? ` Aún se están preparando: ${still.pending.join(', ')} (esas partes pueden verse en negro; vuelve a intentarlo en unos segundos).` : '';
    return { content: [{ type: 'text', text: `Fotograma en ${sec(still.time)} (${still.canvas.width}×${still.canvas.height}).${note}` }, { type: 'image', data, mimeType }] };
  },

  async exportar(a, { signal, progress, unlock }) {
    if (job?.running) throw new Error('Ya hay una exportación en curso: consulta estado_exportacion.');
    const p = store.project;
    const duration = projectDuration(p);
    if (!p.clips.length || duration <= 0) throw new Error('El proyecto está vacío: añade clips antes de exportar.');
    const missing = [...new Set(p.clips.map((c) => c.mediaId && store.getMedia(c.mediaId)).filter((m) => m && m.missing))];
    if (missing.length) throw new Error(`Faltan archivos: ${missing.map((m) => m.path).join(', ')}`);
    const fmt = FORMATS.find((f) => f.id === (a.formato || 'mp4'));
    if (a.fps !== undefined && !(fmt.id === 'gif' ? [10, 12, 15] : [24, 25, 30, 50, 60]).includes(a.fps)) throw new Error(fmt.id === 'gif' ? 'Para GIF, fps debe ser 10, 12 o 15.' : 'fps debe ser 24, 25, 30, 50 o 60.');
    const [info, caps] = await Promise.all([api.app.info(), api.exporter.caps().catch(() => ({ hw: {} }))]);
    const hw = caps.hw || {};
    if (fmt.id === 'mp4-hevc' && !hw.hevc && !hw.software?.x265) throw new Error('Este equipo no puede exportar H.265: usa mp4.');
    const isGif = fmt.id === 'gif';
    const audioOnly = fmt.id === 'mp3' || fmt.id === 'wav';
    const PW = p.settings.width;
    const PH = p.settings.height;
    let w = even(PW);
    let hgt = even(PH);
    const res = a.resolucion || 'proyecto';
    if (isGif) {
      const k = Math.min(1, 480 / Math.max(PW, PH)); // GIF: 480 px de lado mayor
      [w, hgt] = [even(PW * k), even(PH * k)];
    } else if (res !== 'proyecto') {
      const target = parseInt(res, 10);
      const short = Math.min(PW, PH);
      if (target > short * 2) throw new Error(`${res} es demasiado grande para este lienzo (${PW}×${PH}).`);
      [w, hgt] = [even((PW * target) / short), even((PH * target) / short)];
    }
    const outFps = isGif ? Math.min(a.fps ?? p.settings.fps, 15) : a.fps ?? p.settings.fps;
    // Archivo de salida
    let output;
    if (a.ruta) {
      output = cleanPath(a.ruta);
      if (!isAbsolute(output)) throw new Error('ruta debe ser absoluta.');
      if (!new RegExp(`\\.${fmt.ext}$`, 'i').test(output)) output = `${output.replace(/\.[a-z0-9]{2,4}$/i, '')}.${fmt.ext}`;
      if (!a.sobrescribir && (await api.fs.exists([output]))[0]) throw new Error(`Ya existe ${output}. Usa otra ruta o sobrescribir=true si el usuario lo pidió.`);
    } else {
      const dir = localStorage.getItem('litecut.exportDir') || info.paths.videos;
      const name = safeName(p.name && p.name !== 'Proyecto sin título' ? p.name : 'Mi video');
      output = await uniquePath(joinPath(dir, `${name}.${fmt.ext}`));
    }
    const settings = {
      output,
      format: fmt.id,
      width: audioOnly ? PW : w,
      height: audioOnly ? PH : hgt,
      fps: outFps,
      quality: { alta: 'high', recomendada: 'medium', liviana: 'low' }[a.calidad || 'recomendada'],
      useHardware: !!(fmt.id === 'mp4' ? hw.h264 : fmt.id === 'mp4-hevc' ? hw.hevc : null),
    };
    ctx.player.pause();
    const assets = audioOnly ? { text: {} } : await renderTextAssets(p, settings.width);
    const j = { running: true, percent: 0, speed: 0, eta: null, output, format: fmt.id, duration, listeners: new Set(), result: null };
    job = j;
    const off = api.exporter.onProgress((pr) => {
      j.percent = pr.percent || 0;
      j.speed = pr.speed || 0;
      j.eta = pr.eta ?? null;
      updateBanner(j);
      const msg = `Exportando… ${Math.round(j.percent * 100)} %`;
      for (const fn of j.listeners) fn({ progress: Math.round(j.percent * 100), total: 100, message: msg });
    });
    updateBanner(j);
    j.promise = api.exporter
      .start({ project: JSON.parse(store.serialize()), settings, assets })
      .catch((err) => ({ ok: false, error: { message: err.message } }))
      .then((r) => {
        off();
        j.result = r;
        j.running = false;
        updateBanner(j);
        if (r.ok) toast('Video exportado (pedido por la IA)', { timeout: 8000, actions: [{ label: 'Mostrar', onClick: () => api.shell.showItem(r.output) }, { label: 'Abrir', onClick: () => api.shell.openPath(r.output) }] });
        else if (!r.cancelled) toast(`No se pudo exportar: ${r.error?.message || ''}`, { type: 'error', timeout: 8000 });
      });
    unlock(); // mientras se espera, la IA puede seguir usando otras herramientas
    await waitJob(j, a.esperar ?? 40, { signal, progress });
    return describeJob(j);
  },

  async estado_exportacion({ esperar = 40, cancelar }, { signal, progress, unlock }) {
    unlock();
    if (!job) return result('No se ha exportado nada desde que se abrió LiteCut.');
    if (cancelar && job.running) {
      await api.exporter.cancel();
      await waitFor(job.promise, 15);
      return describeJob(job);
    }
    await waitJob(job, esperar, { signal, progress });
    return describeJob(job);
  },

  deshacer({ pasos = 1 }) {
    let n = 0;
    while (n < pasos && store.undo()) n++;
    return result(n ? `Deshecho(s) ${n} cambio(s). Duración: ${sec(projectDuration(store.project))}.` : 'No hay nada que deshacer.');
  },

  rehacer({ pasos = 1 }) {
    let n = 0;
    while (n < pasos && store.redo()) n++;
    return result(n ? `Rehecho(s) ${n} cambio(s). Duración: ${sec(projectDuration(store.project))}.` : 'No hay nada que rehacer.');
  },

  async detectar_silencios({ clip, medio, umbral_db = -35, duracion_minima = 0.5 }, { callId }) {
    const opts = { noise: umbral_db, minDuration: duracion_minima };
    if (medio && !clip) {
      const m = needMedia(medio);
      if (!m.hasAudio) throw new Error(`«${m.name}» no tiene sonido.`);
      const r = await silencesOf(m, opts, callId);
      const total = r.silences.reduce((s, x) => s + x.end - x.start, 0);
      return result(`${r.silences.length} pausa(s) en «${m.name}» (${sec(total)} en total; segundos del archivo).${r.complete ? '' : ` Análisis parcial: hasta ${sec(r.analyzed)}.`}`, {
        medio: m.id,
        silencios: r.silences.map((s) => ({ inicio: r3(s.start), fin: r3(s.end) })),
      });
    }
    const p = store.project;
    const targets = clip ? [needClip(clip)] : soundClipsOfMain(p);
    if (!targets.length) throw new Error('No hay clips con sonido en la pista principal.');
    const found = [];
    let partial = false;
    for (const c of targets) {
      const m = needMedia(c.mediaId);
      if (!m.hasAudio) throw new Error(`El clip ${c.id} no tiene sonido.`);
      const r = await silencesOf(m, opts, callId);
      partial ||= !r.complete;
      const cur = store.getClip(c.id);
      if (cur) for (const s of ops.sourceRangesToTimeline(cur, r.silences)) found.push({ inicio: r3(s.start), fin: r3(s.end), clip: c.id });
    }
    const total = found.reduce((s, x) => s + x.fin - x.inicio, 0);
    return result(`${found.length} pausa(s) en la línea de tiempo (${sec(total)} en total).${partial ? ' Algún archivo se analizó solo en parte.' : ''} Para quitarlas usa cortar_silencios.`, { silencios: found });
  },

  async cortar_silencios({ clips, umbral_db = -35, duracion_minima = 0.6, margen = 0.15 }, { callId }) {
    const p0 = store.project;
    const targets0 = clips?.length ? clips.map(needEditable) : soundClipsOfMain(p0).filter((c) => !store.getTrack(c.trackId)?.locked);
    if (!targets0.length) throw new Error('No hay clips con sonido en la pista principal.');
    const opts = { noise: umbral_db, minDuration: duracion_minima };
    const silences = new Map();
    let partial = false;
    for (const c of targets0) {
      const m = needMedia(c.mediaId);
      if (!m.hasAudio) throw new Error(`El clip ${c.id} no tiene sonido.`);
      if (silences.has(m.id)) continue;
      const r = await silencesOf(m, opts, callId);
      partial ||= !r.complete;
      silences.set(m.id, r.silences);
    }
    // El análisis tardó: se calcula todo con el proyecto tal como está ahora y se aplica de una vez.
    const p = store.project;
    const perTrack = new Map();
    const untouched = [];
    for (const c0 of targets0) {
      const c = store.getClip(c0.id);
      if (!c) continue;
      const ranges = ops.sourceRangesToTimeline(c, silences.get(c.mediaId) || [], { margin: margen, minLength: 0.1 });
      const cut = ranges.reduce((s, r) => s + r.end - r.start, 0);
      if (cut >= c.duration - 0.05) {
        untouched.push(c.id); // todo el clip está en silencio: no se borra
        continue;
      }
      if (!perTrack.has(c.trackId)) perTrack.set(c.trackId, []);
      perTrack.get(c.trackId).push(...ranges);
    }
    let count = 0;
    let removed = 0;
    for (const [tid, ranges] of perTrack) {
      const clean = ops.subtractRanges(ranges, ops.transitionZones(p, tid)).filter((r) => r.end - r.start >= 0.1);
      perTrack.set(tid, clean);
      count += clean.length;
      removed += clean.reduce((s, r) => s + r.end - r.start, 0);
    }
    const before = projectDuration(p);
    if (!count) return result(`No hay pausas de más de ${sec(duracion_minima)} que cortar${untouched.length ? ` (clips en silencio total sin tocar: ${untouched.join(', ')})` : ''}.`);
    change((pp) => {
      for (const [tid, ranges] of perTrack) for (const r of [...ranges].sort((a, b) => b.start - a.start)) ops.removeRange(pp, tid, r.start, r.end);
    });
    show([], 0);
    ctx.timeline?.fitZoom();
    const after = projectDuration(store.project);
    return result(`Cortadas ${count} pausa(s) (${sec(removed)}). Duración: ${sec(before)} → ${sec(after)}. Se deshace con un solo paso.${partial ? ' Algún archivo se analizó solo en parte.' : ''}`, {
      cortes: count,
      segundos_quitados: r3(removed),
      duracion_antes: r3(before),
      duracion_ahora: r3(after),
      ...(untouched.length ? { sin_tocar_por_silencio_total: untouched } : {}),
    });
  },

  async detectar_escenas({ clip, medio, umbral = 12, inicio, duracion }, { callId }) {
    const c = clip ? needClip(clip) : null;
    if (c && !c.mediaId) throw new Error('Ese clip es un texto: no tiene escenas.');
    const m = c ? needMedia(c.mediaId) : medio ? needMedia(medio) : defaultVideoMedia();
    if (m.kind !== 'video') throw new Error(`«${m.name}» no es un video.`);
    let start = inicio ?? 0;
    let dur = duracion ?? 0;
    if (c && inicio === undefined) {
      start = c.in;
      dur = duracion ?? c.duration * (c.speed || 1);
    }
    const r = await api.ai.scenes({ file: m.proxyPath || m.path, threshold: umbral, start, duration: dur, callId });
    if (!r.ok) throw new Error(r.error);
    const v = r.value;
    const scenes = v.scenes.map((s) => {
      const o = { tiempo_archivo: r3(s.time), puntuacion: r3(s.score) };
      if (c) o.tiempo = r3(c.start + (s.time - c.in) / (c.speed || 1));
      return o;
    });
    const tail = v.complete ? '' : ` Análisis parcial hasta ${sec(v.analyzedUntil)} del archivo: vuelve a llamar con inicio=${r3(v.analyzedUntil)} para seguir.`;
    return result(`${scenes.length} cambio(s) de escena en «${m.name}».${tail}`, { escenas: scenes, completo: v.complete });
  },

  async fotogramas_de_muestra({ clip, medio, cantidad = 6, ancho = 320, inicio, fin }, { callId }) {
    let c = null;
    let m;
    let s0;
    let s1;
    if (clip) {
      c = needClip(clip);
      if (!c.mediaId) throw new Error('Ese clip es un texto: usa ver_fotograma.');
      m = needMedia(c.mediaId);
      const sp = c.speed || 1;
      const a = Math.max(c.start, inicio ?? c.start);
      const b = Math.min(clipEnd(c), fin ?? clipEnd(c));
      if (!(b > a)) throw new Error('El tramo pedido queda fuera del clip.');
      s0 = c.in + (a - c.start) * sp;
      s1 = c.in + (b - c.start) * sp;
    } else {
      m = medio ? needMedia(medio) : defaultVideoMedia();
      s0 = inicio ?? 0;
      s1 = Math.min(fin ?? m.duration, m.duration || 0);
      if (m.kind !== 'image' && !(s1 > s0)) throw new Error('El tramo pedido queda fuera del archivo.');
    }
    if (m.kind === 'audio') throw new Error(`«${m.name}» es un audio: no tiene imágenes.`);
    const r = await api.ai.samples({ file: m.proxyPath || m.path, start: s0, end: s1, count: m.kind === 'image' ? 1 : cantidad, width: ancho, format: 'jpeg', vcodec: m.proxyPath ? 'h264' : m.vcodec, isImage: m.kind === 'image', callId });
    if (!r.ok) throw new Error(r.error);
    const content = [{ type: 'text', text: `${r.value.length} imagen(es) de «${m.name}»${c ? ` (clip ${c.id})` : ''}:` }];
    r.value.forEach((f, i) => {
      const label = c ? `${sec(c.start + (f.time - c.in) / (c.speed || 1))} de la línea de tiempo (${sec(f.time)} del archivo)` : m.kind === 'image' ? 'foto' : `${sec(f.time)} del archivo`;
      content.push({ type: 'text', text: `#${i + 1}: ${label}` }, { type: 'image', data: f.data, mimeType: f.mimeType });
    });
    return { content };
  },

  async guardar_proyecto({ ruta }) {
    const p = store.project;
    let file = ruta ? cleanPath(ruta) : store.projectPath;
    if (file && !isAbsolute(file)) throw new Error('ruta debe ser absoluta.');
    if (file && !/\.lcproj$/i.test(file)) file += '.lcproj';
    if (!file) {
      const info = await api.app.info();
      file = await uniquePath(joinPath(info.paths.documents, `${safeName(p.name)}.lcproj`));
    }
    const overwrite = samePath(file, store.projectPath);
    if (!overwrite && (await api.fs.exists([file]))[0]) throw new Error(`Ya existe ${file}: indica otra ruta.`);
    if (p.name === 'Proyecto sin título') p.name = file.split(/[\\/]/).pop().replace(/\.lcproj$/i, '');
    const r = await api.ai.saveProject(file, store.serialize(), { overwrite });
    if (!r.ok) throw new Error(r.error);
    store.projectPath = file;
    store.setDirty(false);
    api.project.addRecent(file, p.name);
    api.project.clearAutosave();
    ctx.onSaved?.();
    return result(`Proyecto guardado en ${file}.`);
  },
};

// Texto: aplica los parámetros de la IA a un clip de texto (borrador, fuera del store).
function applyTextArgs(c, a) {
  const t = c.text;
  const P = store.project.settings;
  if (a.texto !== undefined) t.content = String(a.texto);
  if (a.tamano !== undefined) t.size = a.tamano;
  if (a.color !== undefined) t.color = color(a.color, 'color');
  if (a.fuente !== undefined) t.font = a.fuente;
  if (a.grosor !== undefined) t.weight = a.grosor;
  if (a.cursiva !== undefined) t.italic = a.cursiva;
  if (a.mayusculas !== undefined) t.uppercase = a.mayusculas;
  if (a.alineacion !== undefined) t.align = a.alineacion;
  if (a.contorno !== undefined) t.strokeWidth = a.contorno;
  if (a.color_contorno !== undefined) t.strokeColor = color(a.color_contorno, 'color_contorno');
  if (a.sombra !== undefined) {
    t.shadowBlur = a.sombra;
    if (a.sombra > 0 && !(t.shadowOpacity > 0)) t.shadowOpacity = 0.6;
  }
  if (a.fondo !== undefined) {
    t.bgColor = color(a.fondo, 'fondo');
    if (a.opacidad_fondo === undefined && !(t.bgOpacity > 0)) t.bgOpacity = 0.7;
  }
  if (a.opacidad_fondo !== undefined) t.bgOpacity = a.opacidad_fondo;
  if (a.animacion_entrada !== undefined) c.animIn.type = a.animacion_entrada;
  if (a.animacion_salida !== undefined) c.animOut.type = a.animacion_salida;
  if (a.posicion) {
    c.transform.x = 0;
    c.transform.y = { arriba: -0.32, centro: 0, abajo: 0.32 }[a.posicion] * P.height;
  }
  if (a.x !== undefined) c.transform.x = Math.round(a.x);
  if (a.y !== undefined) c.transform.y = Math.round(a.y);
  c.name = (t.content.split('\n')[0] || 'Texto').slice(0, 40);
}

// Si el texto no cabe en el ancho del lienzo (o se sale por arriba o por abajo), se achica y se recoloca.
async function fitText(c, a) {
  const t = c.text;
  const P = store.project.settings;
  await ensureFont(t);
  const scale = c.transform.scale || 1;
  let cv = renderTextCanvas(t, scale);
  if (a.tamano === undefined && cv.width > P.width * 0.92) {
    t.size = Math.max(12, Math.floor(t.size * ((P.width * 0.92) / cv.width)));
    cv = renderTextCanvas(t, scale);
  }
  const maxY = Math.max(0, P.height / 2 - cv.height / 2 - P.height * 0.03);
  if (a.y === undefined) c.transform.y = clamp(c.transform.y, -maxY, maxY);
}

// ---------- Ejecución ----------
// Las herramientas se ejecutan de una en una (la vista previa y el historial son compartidos). Una herramienta
// que solo espera (exportar) libera el turno con unlock().
let tail = Promise.resolve();
function enqueue(task) {
  let release;
  const done = new Promise((r) => (release = r));
  const start = tail;
  tail = start.then(() => done);
  return start.then(() => task(release)).finally(() => release());
}

export async function runCommand(name, rawArgs, { signal, progress, callId, unlock = () => {} } = {}) {
  if (!AI_TOOL_MAP.has(name)) throw new Error(`Herramienta desconocida: ${name}`);
  const args = validateArgs(name, rawArgs);
  return handlers[name](args, { signal, progress, callId, unlock });
}

export function initAiCommands(context) {
  ctx = context;
  const controllers = new Map();
  api.ai.onCall(({ id, name, args, client }) => {
    const ac = new AbortController();
    controllers.set(id, ac);
    const title = AI_TOOL_MAP.get(name)?.title || name;
    enqueue(async (release) => {
      ctx.onActivity?.({ state: 'start', name, title, client });
      let ok = false;
      try {
        const value = await runCommand(name, args, { signal: ac.signal, callId: id, progress: (p) => api.ai.progress(id, p), unlock: release });
        api.ai.reply(id, { ok: true, value });
        ok = !value?.isError;
      } catch (err) {
        api.ai.reply(id, { ok: false, error: err?.message || String(err) });
      } finally {
        controllers.delete(id);
        ctx.onActivity?.({ state: 'done', name, title, client, error: !ok });
        window.dispatchEvent(new CustomEvent('litecut:ai', { detail: { name, ok } })); // para las pruebas automáticas
      }
    });
  });
  api.ai.onCancel((id) => controllers.get(id)?.abort());
  api.ai.ready();
}

// Para probar desde la consola de desarrollo: await window.__app.ai('ver_proyecto', {})
export const runQueued = (name, args) => enqueue((release) => runCommand(name, args, { unlock: release }));
