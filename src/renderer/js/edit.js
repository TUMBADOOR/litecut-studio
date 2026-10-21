// Comandos de edición de alto nivel (usados por la línea de tiempo, menús, atajos e inspector).
import { store } from './store.js';
import { media } from './media.js';
import * as ops from '../shared/ops.js';
import { createClip, clipEnd, mainTrack, isVisual, snapToFrame, clone, defaultAdjust, DEFAULT_TEXT_DURATION } from '../shared/model.js';
import { FILTER_PRESETS } from '../shared/effects.js';
import { TEXT_PRESETS } from './text-render.js';
import { toast } from './ui.js';

const defaultAdjustFor = (preset) => ({ ...defaultAdjust(), ...preset.adjust });

let player = null;
export function setPlayer(p) {
  player = p;
}
export const playheadTime = () => (player ? player.time : 0);
const fps = () => store.project.settings.fps || 30;
const unlocked = (c) => !store.getTrack(c.trackId)?.locked;

export function addMediaClip(mediaId, { trackId = null, start = null, newTrack = null } = {}) {
  const m = store.getMedia(mediaId);
  if (!m) return null;
  if (m.missing) {
    toast('El archivo no se encuentra. Vuelve a enlazarlo desde la biblioteca.', { type: 'error' });
    return null;
  }
  const clip = store.mutate((p) => {
    let tid = trackId;
    if (newTrack && (newTrack === 'audio') === (m.kind === 'audio')) tid = ops.addTrack(p, newTrack).id;
    return ops.addMediaClip(p, m, { t: playheadTime(), trackId: tid, start: start === null ? null : snapToFrame(start, fps()), imageDuration: 5 });
  });
  if (clip) store.select([clip.id]);
  return clip;
}

// Pista superior libre para textos/stickers en [s, e).
function overlayTrackFor(p, s, e, preferred) {
  const main = mainTrack(p);
  const pref = preferred ? ops.findTrack(p, preferred) : null;
  if (pref && pref.kind === 'video' && !pref.locked && ops.isFree(p, pref.id, s, e)) return pref;
  if (pref && pref.kind === 'video' && pref.id === main?.id) return pref;
  return ops.findFreeTrack(p, 'video', s, e);
}

export function addText(presetId = 'title', { trackId = null, start = null } = {}) {
  const preset = TEXT_PRESETS.find((x) => x.id === presetId) || TEXT_PRESETS[0];
  const clip = store.mutate((p) => {
    const s = snapToFrame(start ?? playheadTime(), fps());
    const c = createClip('text', { name: preset.name, start: s, duration: DEFAULT_TEXT_DURATION });
    Object.assign(c.text, clone(preset.text));
    if (preset.x) c.transform.x = preset.x * (p.settings.width / 1920);
    if (preset.y) c.transform.y = preset.y * (p.settings.height / 1080);
    const tr = overlayTrackFor(p, s, s + c.duration, trackId);
    p.clips.push(c);
    c.start = -1e9;
    ops.placeClip(p, c, tr.id, s);
    return c;
  });
  store.select([clip.id]);
  return clip;
}

export function addSticker(emoji, { trackId = null, start = null } = {}) {
  const clip = store.mutate((p) => {
    const s = snapToFrame(start ?? playheadTime(), fps());
    const c = createClip('text', { name: `Sticker ${emoji}`, start: s, duration: 3 });
    Object.assign(c.text, { content: emoji, font: 'Arial', weight: 400, size: 220, color: '#ffffff', strokeWidth: 0, shadowBlur: 0 });
    c.animIn = { type: 'pop', duration: 0.5 };
    const tr = overlayTrackFor(p, s, s + c.duration, trackId);
    p.clips.push(c);
    c.start = -1e9;
    ops.placeClip(p, c, tr.id, s);
    return c;
  });
  store.select([clip.id]);
  return clip;
}

export function splitAtPlayhead() {
  const t = snapToFrame(playheadTime(), fps());
  const under = (c) => t > c.start + 0.01 && t < clipEnd(c) - 0.01;
  let targets = store.selectedClips.filter((c) => under(c) && unlocked(c));
  if (!targets.length) targets = store.project.clips.filter((c) => under(c) && unlocked(c));
  // El audio vinculado se divide junto con su video.
  const ids = new Set(targets.map((c) => c.id));
  targets = targets.filter((c) => !(c.type === 'audio' && c.linkedTo && ids.has(c.linkedTo)));
  if (!targets.length) {
    toast('Coloca el cursor sobre un clip para dividirlo', { timeout: 2000 });
    return;
  }
  const created = store.mutate((p) => targets.map((c) => ops.splitClip(p, c.id, t)).filter(Boolean));
  if (created.length) store.select(created.map((c) => c.id));
}

export function deleteSelected(ripple = false) {
  const ids = store.selectedClips.filter(unlocked).map((c) => c.id);
  if (store.selectedTransition) {
    removeTransition(store.selectedTransition);
    return;
  }
  if (!ids.length) return;
  store.mutate((p) => ops.deleteClips(p, ids, { ripple }));
  store.clearSelection();
}

export function duplicateSelected() {
  const ids = store.selectedClips.filter(unlocked).map((c) => c.id);
  if (!ids.length) return;
  const created = store.mutate((p) => ops.duplicateClips(p, ids));
  store.select(created.map((c) => c.id));
}

export function copySelected() {
  const clips = store.selectedClips;
  if (!clips.length) return false;
  store.clipboard = clone(clips);
  toast(clips.length === 1 ? 'Clip copiado' : `${clips.length} clips copiados`, { timeout: 1400 });
  return true;
}

export function cutSelected() {
  if (copySelected()) deleteSelected(false);
}

export function paste() {
  if (!store.clipboard?.length) return;
  const created = store.mutate((p) => ops.pasteClips(p, store.clipboard, snapToFrame(playheadTime(), fps())));
  store.select(created.map((c) => c.id));
}

export function selectAll() {
  store.select(store.project.clips.map((c) => c.id));
}

export function detachAudioSelected() {
  const c = store.singleSelected;
  const m = c && store.getMedia(c.mediaId);
  if (!c || c.type !== 'video' || !m?.hasAudio) {
    toast('Selecciona un clip de video con audio', { timeout: 2000 });
    return;
  }
  if (c.muted) {
    toast('El audio de este clip ya está separado o silenciado', { timeout: 2200 });
    return;
  }
  const a = store.mutate((p) => ops.detachAudio(p, c.id));
  if (a) store.select([a.id]);
}

export function reattachAudio(clipId) {
  store.mutate((p) => ops.reattachAudio(p, clipId));
}

export async function freezeFrameSelected() {
  let c = store.singleSelected;
  const t = snapToFrame(playheadTime(), fps());
  const under = (x) => x.type === 'video' && t >= x.start && t < clipEnd(x);
  if (!c || !under(c)) {
    // Prioriza el video visible (pista superior) bajo el cursor.
    const order = new Map(store.project.tracks.map((tr, i) => [tr.id, i]));
    c = store.project.clips.filter(under).sort((a, b) => order.get(a.trackId) - order.get(b.trackId))[0];
  }
  if (!c) {
    toast('Coloca el cursor sobre un clip de video', { timeout: 2000 });
    return;
  }
  const m = store.getMedia(c.mediaId);
  const srcTime = c.in + (t - c.start) * c.speed;
  const close = toast('Congelando fotograma…', { timeout: 0 });
  const r = await window.api.media.frame(m.path, srcTime);
  close();
  if (!r.ok) {
    toast(`No se pudo congelar: ${r.error.message}`, { type: 'error' });
    return;
  }
  const [img] = await media.importPaths([r.path]);
  if (!img) return;
  const clip = store.mutate((p) => ops.insertFreeze(p, c.id, t, img.id, 2));
  if (clip) store.select([clip.id]);
}

export function closeGapsMain() {
  const main = mainTrack(store.project);
  if (!main) return;
  store.mutate((p) => ops.closeGaps(p, main.id));
}

export function applyTransition(clipId, type = 'fade', duration = 0.6) {
  const ok = store.mutate((p) => ops.applyTransition(p, clipId, type, duration));
  if (!ok) toast('Las transiciones se aplican entre dos clips seguidos de la pista principal', { timeout: 3000 });
  else {
    store.selectTransition(clipId);
  }
  return ok;
}

// Aplica la transición a la unión de la pista principal más cercana al cursor (o al clip seleccionado).
export function applyTransitionNearPlayhead(type) {
  const sel = store.singleSelected;
  const main = mainTrack(store.project);
  let target = null;
  if (sel && main && sel.trackId === main.id && isVisual(sel)) {
    const list = store.project.clips.filter((c) => c.trackId === main.id && c.id !== sel.id && isVisual(c));
    target = list.some((c) => c.start < sel.start) ? sel : null;
  }
  if (!target) target = ops.junctionNear(store.project, playheadTime());
  if (!target) {
    toast('Añade al menos dos clips seguidos a la pista principal', { timeout: 3000 });
    return;
  }
  applyTransition(target.id, type, target.transitionIn?.duration || 0.6);
}

export function removeTransition(clipId) {
  store.mutate((p) => ops.removeTransition(p, clipId));
  store.selectTransition(null);
}

export function applyFilterPreset(ids, presetId) {
  const preset = FILTER_PRESETS.find((f) => f.id === presetId);
  if (!preset) return;
  const targets = ids.map((id) => store.getClip(id)).filter((c) => c && (c.type === 'video' || c.type === 'image'));
  if (!targets.length) {
    toast('Selecciona un clip de video o imagen para aplicar el filtro', { timeout: 2400 });
    return;
  }
  store.mutate(() => {
    for (const c of targets) {
      c.adjust = defaultAdjustFor(preset);
      c.filter = preset.id;
    }
  });
}

export function setTrackFlag(trackId, flag) {
  store.mutate((p) => {
    const t = ops.findTrack(p, trackId);
    if (t) t[flag] = !t[flag];
  });
}

export function addTrack(kind) {
  store.mutate((p) => ops.addTrack(p, kind));
}

export function removeTrack(trackId) {
  const ok = store.mutate((p) => ops.removeTrack(p, trackId));
  if (!ok) toast('Debe quedar al menos una pista de video', { timeout: 2200 });
}

export function nudgeSelected(dt) {
  const clips = store.selectedClips.filter(unlocked);
  if (!clips.length) return false;
  store.mutate((p) =>
    ops.moveClips(
      p,
      clips.map((c) => ({ id: c.id, start: Math.max(0, snapToFrame(c.start + dt, fps())), trackId: c.trackId }))
    )
  );
  return true;
}
