// Herramientas de edición: efectos, marcadores y las que analizan el audio o el video con FFmpeg
// (ritmo, silencios, escenas, volumen e invertir). Todas se deshacen con un solo Ctrl+Z.
// Cada una tiene su lógica (devuelve el resultado o lanza un error; la usan también las herramientas de IA)
// y una versión para los botones que muestra el progreso y el resultado en pantalla.
import { store } from './store.js';
import { media } from './media.js';
import { h, toast } from './ui.js';
import * as ops from '../shared/ops.js';
import { clipEnd, isVisual, snapToFrame } from '../shared/model.js';
import { EFFECTS, beatGridFor } from '../shared/effects.js';
import { toggleMarker, removeMarkers, clearBeatMarkers, setBeatMarkers, beatsToTimeline } from '../shared/markers.js';
import { runQueued } from './ai-commands.js';

const api = window.api;
const fps = () => store.project.settings.fps || 30;
const unlocked = (c) => !store.getTrack(c.trackId)?.locked;
let player = null;
export function setToolsPlayer(p) {
  player = p;
}

// Aviso con rueda (y porcentaje si se conoce) mientras dura una tarea larga.
async function working(text, fn) {
  const txt = h('span', { class: 'txt' }, text);
  const banner = h('div', { class: 'proc-banner' }, h('span', { class: 'spinner' }), txt);
  document.body.append(banner);
  try {
    return await fn((p) => (txt.textContent = `${text} ${Math.round(p * 100)} %`));
  } finally {
    banner.remove();
  }
}

// Versión para botones: ejecuta, muestra el resultado (o el error) y no lanza.
async function run(text, fn, done) {
  try {
    const r = await working(text, fn);
    if (r !== undefined) done(r);
  } catch (err) {
    toast(err.message, { type: 'error', timeout: 6000 });
  }
}

const pickClip = (id) => store.getClip(id) || store.singleSelected;
const soundClip = (c) => !!(c && c.mediaId && store.getMedia(c.mediaId)?.hasAudio && !c.muted);

// ---------- Efectos ----------
export const effectOf = (c, type) => (c?.effects || []).find((e) => e.type === type) || null;

// Pone (o quita) un efecto en varios clips. El pulso toma el compás de los marcadores de ritmo si los hay.
// Devuelve cuántos clips cambiaron y cuántos quedaron al ritmo.
export function setEffect(ids, type, { intensity = 0.5, remove = false } = {}) {
  if (!EFFECTS.some((e) => e.id === type)) throw new Error(`Efecto desconocido: ${type}`);
  const clips = ids.map((id) => store.getClip(id)).filter((c) => c && isVisual(c) && unlocked(c));
  if (!clips.length) throw new Error('Elige clips de video, imagen o texto (de pistas sin bloquear).');
  let synced = 0;
  store.mutate((p) => {
    for (const c0 of clips) {
      const c = ops.findClip(p, c0.id);
      c.effects = (c.effects || []).filter((e) => e.type !== type);
      if (remove) continue;
      const fx = { type, intensity: Math.min(1, Math.max(0.1, intensity)) };
      if (type === 'zoom-pulse') {
        const grid = beatGridFor(c, p.markers);
        if (grid) synced++;
        Object.assign(fx, grid || { period: 0.5, phase: 0 });
      }
      c.effects.push(fx);
    }
  });
  return { count: clips.length, synced };
}

// Botones de la pestaña Efectos: pone el efecto en la selección, o lo quita si todos lo tenían.
export function toggleEffect(type, ids = store.selectedClips.filter((c) => isVisual(c) && unlocked(c)).map((c) => c.id)) {
  const def = EFFECTS.find((e) => e.id === type);
  if (!def) return;
  if (!ids.length) {
    toast('Selecciona uno o más clips de video, imagen o texto para aplicarles el efecto.', { timeout: 3500 });
    return;
  }
  const remove = ids.every((id) => effectOf(store.getClip(id), type));
  const r = setEffect(ids, type, { remove });
  if (remove) toast(`Efecto «${def.name}» quitado`, { timeout: 1500 });
  else if (type === 'zoom-pulse' && !r.synced) toast('Pulso cada 0,5 s. Usa «Detectar ritmo» en la música antes de aplicarlo para que siga los golpes.', { timeout: 6000 });
  else toast(`Efecto «${def.name}» aplicado${r.synced ? ' al ritmo de la música' : ''}. Ajusta la intensidad en Animación.`, { timeout: 2500 });
}

export function removeEffect(clipId, type) {
  setEffect([clipId], type, { remove: true });
}

// ---------- Marcadores ----------
export function toggleMarkerAtPlayhead() {
  const t = snapToFrame(player ? player.time : 0, fps());
  const added = store.mutate((p) => toggleMarker(p, t, fps()));
  toast(added ? 'Marcador añadido (M otra vez lo quita)' : 'Marcador quitado', { timeout: 1200 });
}

export function deleteMarker(id) {
  store.mutate((p) => removeMarkers(p, [id]));
}

export function clearBeats() {
  store.mutate((p) => clearBeatMarkers(p));
}

// Pulsos de la música de un clip con sonido → marcadores de ritmo. Devuelve { bpm, times } (línea de tiempo).
export async function beatMarkers(clipId) {
  const c = store.getClip(clipId);
  if (!soundClip(c)) throw new Error('Elige un clip con música para detectar su ritmo.');
  const m = store.getMedia(c.mediaId);
  const r = await api.media.beats({ file: m.path, start: c.in, duration: c.duration * (c.speed || 1) });
  if (!r.ok) throw new Error(`No se pudo analizar el audio: ${r.error.message}`);
  const cur = store.getClip(c.id);
  if (!cur) throw new Error('El clip ya no existe.');
  const times = [...new Set(beatsToTimeline(cur, r.beats).map((t) => snapToFrame(t, fps())))];
  if (times.length < 2) throw new Error('No se encontró un ritmo claro en ese clip.');
  store.mutate((p) => setBeatMarkers(p, times, cur.start, clipEnd(cur)));
  return { bpm: Math.round(r.bpm * (cur.speed || 1)), times };
}

export function detectBeats(clipId) {
  const c = pickClip(clipId);
  return run('Buscando el ritmo de la música…', () => beatMarkers(c?.id), (r) =>
    toast(`Ritmo: ${r.bpm} BPM · ${r.times.length} marcadores. El imán se pega a ellos al cortar y mover clips.`, { timeout: 6000 })
  );
}

// ---------- Silencios (usa la herramienta de la IA, que ya sabe cortarlos en una sola acción) ----------
export function removeSilences(ids = store.selectedClips.map((c) => c.id)) {
  const clips = ids.map((id) => store.getClip(id)).filter((c) => soundClip(c) && unlocked(c));
  if (!clips.length) return toast('Selecciona clips con sonido (voz) para quitarles los silencios.', { type: 'error' });
  return run(
    'Buscando silencios…',
    () => runQueued('cortar_silencios', { clips: clips.map((c) => c.id) }),
    (r) => {
      const text = (r?.content?.[0]?.text || '').split('\n')[0].replace(/ Se deshace con un solo paso\./, ' Ctrl+Z lo deshace.');
      toast(text || 'Listo.', { type: r?.isError ? 'error' : 'info', timeout: 6000 });
    }
  );
}

// ---------- Escenas ----------
// Divide un clip de video en cada cambio de plano. Devuelve los ids de los trozos.
export async function sceneSplit(clipId, progress = () => {}) {
  const c = store.getClip(clipId);
  const m = c?.mediaId ? store.getMedia(c.mediaId) : null;
  if (!c || c.type !== 'video' || !m) throw new Error('Elige un clip de video para dividirlo por escenas.');
  const sp = c.speed || 1;
  const a = c.in;
  const b = c.in + c.duration * sp;
  const pv = media.previewFor(m, a, b); // con la copia ligera se analiza mucho más rápido (sobre todo en AV1)
  const found = [];
  let from = a;
  while (from < b - 0.05) {
    const r = await api.ai.scenes({ file: pv.path, threshold: 12, start: from - pv.offset, duration: b - from });
    if (!r.ok) throw new Error(`No se pudo analizar el video: ${r.error}`);
    for (const s of r.value.scenes) found.push(s.time + pv.offset);
    if (r.value.complete) break;
    const next = r.value.analyzedUntil + pv.offset;
    if (!(next > from + 0.05)) break;
    from = next;
    progress((from - a) / (b - a));
  }
  const cur = store.getClip(c.id);
  if (!cur) throw new Error('El clip ya no existe.');
  const min = 0.3; // no se crean trozos de menos de 0,3 s
  const cuts = [...new Set(found.map((s) => snapToFrame(cur.start + (s - cur.in) / sp, fps())))]
    .sort((x, y) => x - y)
    .filter((t, i, arr) => t > cur.start + min && t < clipEnd(cur) - min && (i === 0 || t - arr[i - 1] >= min));
  if (!cuts.length) return [cur.id];
  return store.mutate((p) => {
    let last = cur.id;
    const out = [cur.id];
    for (const t of cuts) {
      const n = ops.splitClip(p, last, t);
      if (!n) continue;
      out.push(n.id);
      last = n.id;
    }
    return out;
  });
}

export function splitAtScenes(clipId) {
  const c = pickClip(clipId);
  return run('Buscando cambios de escena…', (progress) => sceneSplit(c?.id, progress), (ids) => {
    if (ids.length < 2) return toast('No se encontraron cambios de escena en ese clip.', { timeout: 3500 });
    store.select(ids);
    toast(`Clip dividido en ${ids.length} escenas. Ctrl+Z lo deshace.`, { timeout: 4000 });
  });
}

// ---------- Volumen ----------
// Ajusta el volumen a −14 LUFS (lo habitual en YouTube, TikTok o Spotify) sin pasar de −1 dB de pico.
// Devuelve un Map id → volumen nuevo.
export async function normalizeClips(ids, progress = () => {}) {
  const clips = ids.map((id) => store.getClip(id)).filter(soundClip);
  if (!clips.length) throw new Error('Elige clips con sonido para normalizar su volumen.');
  const vols = new Map();
  for (const [i, c] of clips.entries()) {
    const m = store.getMedia(c.mediaId);
    const r = await api.media.loudness({ file: m.path, start: c.in, duration: c.duration * (c.speed || 1) });
    if (!r.ok) throw new Error(`No se pudo medir «${m.name}»: ${r.error.message}`);
    if (Number.isFinite(r.lufs)) {
      const gainDb = Math.min(-14 - r.lufs, -1 - (Number.isFinite(r.peak) ? r.peak : -60));
      vols.set(c.id, Math.min(4, Math.max(0.05, Math.round(10 ** (gainDb / 20) * 100) / 100)));
    }
    progress((i + 1) / clips.length);
  }
  if (vols.size)
    store.mutate((p) => {
      for (const [id, v] of vols) {
        const c = ops.findClip(p, id);
        if (c) c.volume = v;
      }
    });
  return vols;
}

export function normalizeVolume(ids = store.selectedClips.map((c) => c.id)) {
  return run('Midiendo el volumen…', (progress) => normalizeClips(ids, progress), (vols) => {
    if (!vols.size) return toast('Esos clips están en silencio.', { timeout: 3000 });
    toast(`Volumen normalizado (${[...vols.values()].map((v) => `${Math.round(v * 100)} %`).join(', ')}). Ctrl+Z lo deshace.`, { timeout: 4000 });
  });
}

// ---------- Invertir ----------
// Cambia el clip por una copia invertida del tramo que usa (con su audio separado, si lo tiene). Si ya estaba
// invertido, vuelve al original. Devuelve { restored }.
export async function reverseCore(clipId, progress = () => {}) {
  const c = store.getClip(clipId);
  const m = c?.mediaId ? store.getMedia(c.mediaId) : null;
  if (!c || !m || (c.type !== 'video' && c.type !== 'audio')) throw new Error('Elige un clip de video o de audio para invertirlo.');
  const linked = store.project.clips.filter((x) => x.linkedTo === c.id).map((x) => x.id);
  // En el archivo invertido, el segundo r corresponde al end − r del original (y al revés).
  const remap = (mediaId, end) =>
    store.mutate((p) => {
      for (const id of [c.id, ...linked]) {
        const x = ops.findClip(p, id);
        if (!x) continue;
        x.in = Math.max(0, end - (x.in + x.duration * (x.speed || 1)));
        x.mediaId = mediaId;
      }
    });
  if (m.reversedFrom && store.getMedia(m.reversedFrom.mediaId)) {
    remap(m.reversedFrom.mediaId, m.reversedFrom.end);
    return { restored: true };
  }
  const a = c.in;
  const len = c.duration * (c.speed || 1);
  const unsub = api.media.onReverseProgress(({ id, progress: p }) => id === c.id && progress(p));
  try {
    const r = await api.media.reverse({
      id: c.id,
      file: m.path,
      name: m.name,
      start: a,
      duration: len,
      width: m.width,
      height: m.height,
      fps: m.fps || 30,
      hasVideo: m.kind === 'video' && m.hasVideo !== false,
      hasAudio: !!m.hasAudio,
    });
    if (!r.ok) throw new Error(`No se pudo invertir: ${r.error.message}`);
    const [nm] = await media.importPaths([r.path]);
    if (!nm) throw new Error('No se pudo abrir el clip invertido.');
    store.updateMedia(nm.id, { reversedFrom: { mediaId: m.id, start: a, end: a + len }, name: `${m.name} (invertido)` });
    remap(nm.id, a + len);
    return { restored: false };
  } finally {
    unsub?.();
  }
}

export function reverseClip(clipId) {
  const c = pickClip(clipId);
  return run('Invirtiendo el clip…', (progress) => reverseCore(c?.id, progress), (r) =>
    toast(r.restored ? 'El clip vuelve a reproducirse hacia delante.' : 'Clip invertido (va hacia atrás). Ctrl+Z lo deshace; «Invertir» otra vez lo devuelve.', { timeout: 4500 })
  );
}
