// Operaciones de edición sobre el proyecto (funciones puras sobre el objeto proyecto).
import {
  clipEnd,
  trackClips,
  mainTrack,
  createClip,
  createTrack,
  uid,
  clone,
  MIN_CLIP,
  isVisual,
  videoTracks,
  audioTracks,
  maxClipDuration,
} from './model.js';

const EPS = 1e-4;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const byStart = (a, b) => a.start - b.start;

export const findClip = (p, id) => p.clips.find((c) => c.id === id) || null;
export const findTrack = (p, id) => p.tracks.find((t) => t.id === id) || null;
export const findMedia = (p, id) => p.media.find((m) => m.id === id) || null;

export function trackKindFor(clip) {
  return clip.type === 'audio' ? 'audio' : 'video';
}

// Deja el proyecto en un estado coherente después de cualquier edición.
export function sanitizeProject(p) {
  const main = mainTrack(p);
  const trackIds = new Set(p.tracks.map((t) => t.id));
  p.clips = p.clips.filter((c) => trackIds.has(c.trackId));
  // El audio separado sigue a su video (posición, recorte y velocidad).
  for (const a of p.clips) {
    if (a.type !== 'audio' || !a.linkedTo) continue;
    const v = findClip(p, a.linkedTo);
    if (!v || v.type !== 'video' || v.mediaId !== a.mediaId || !v.muted) {
      a.linkedTo = null;
      continue;
    }
    a.start = v.start;
    a.duration = v.duration;
    a.in = v.in;
    a.speed = v.speed;
  }
  for (const c of p.clips) {
    c.start = Math.max(0, Number(c.start) || 0);
    c.speed = clamp(Number(c.speed) || 1, 0.1, 16);
    c.in = Math.max(0, Number(c.in) || 0);
    const m = c.mediaId ? findMedia(p, c.mediaId) : null;
    const maxD = maxClipDuration(c, m);
    c.duration = clamp(Number(c.duration) || MIN_CLIP, MIN_CLIP, isFinite(maxD) ? Math.max(MIN_CLIP, maxD + 0.001) : 1e6);
  }
  for (const tr of p.tracks) {
    const list = trackClips(p, tr.id);
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      if (!c.transitionIn) continue;
      const prev = list[i - 1];
      if (!main || tr.id !== main.id || !prev || !isVisual(c) || !isVisual(prev)) {
        c.transitionIn = null;
        continue;
      }
      const ov = clipEnd(prev) - c.start;
      if (ov < 0.05) c.transitionIn = null;
      else c.transitionIn.duration = Math.round(ov * 1000) / 1000;
    }
  }
  return p;
}

export function isFree(p, trackId, s, e, excludeIds = []) {
  const ex = new Set(Array.isArray(excludeIds) ? excludeIds : [excludeIds]);
  return !p.clips.some((o) => o.trackId === trackId && !ex.has(o.id) && o.start < e - EPS && clipEnd(o) > s + EPS);
}

export function addTrack(p, kind, { top = true } = {}) {
  const t = createTrack(kind);
  if (kind === 'video') {
    if (top) p.tracks.unshift(t);
    else {
      const idx = p.tracks.findIndex((x) => x.kind !== 'video');
      p.tracks.splice(idx < 0 ? p.tracks.length : idx, 0, t);
    }
  } else p.tracks.push(t);
  return t;
}

// Busca una pista del tipo indicado libre en [s, e); si no hay, crea una.
export function findFreeTrack(p, kind, s, e, excludeIds = []) {
  const candidates = kind === 'video' ? videoTracks(p).slice(0, -1).reverse() : audioTracks(p);
  for (const t of candidates) if (!t.locked && isFree(p, t.id, s, e, excludeIds)) return t;
  return addTrack(p, kind);
}

// Coloca un clip en una pista. En la pista principal inserta y desplaza (como CapCut);
// en las demás, si el hueco está ocupado, usa otra pista libre.
export function placeClip(p, clip, trackId, start) {
  const tr = findTrack(p, trackId);
  const main = mainTrack(p);
  let s = Math.max(0, start);
  if (!tr) return;
  if (tr.kind === 'video' && main && tr.id === main.id) {
    clip.trackId = tr.id;
    const others = trackClips(p, tr.id).filter((o) => o.id !== clip.id);
    const hit = others.filter((o) => o.start < s + clip.duration - EPS && clipEnd(o) > s + EPS).sort(byStart)[0];
    if (!hit) {
      clip.start = s;
      return;
    }
    let at = s < hit.start + hit.duration / 2 ? hit.start : clipEnd(hit);
    let moved = true;
    while (moved) {
      moved = false;
      for (const o of others)
        if (o.start < at - EPS && clipEnd(o) > at + EPS) {
          at = clipEnd(o);
          moved = true;
        }
    }
    clip.start = at;
    const after = others.filter((o) => o.start >= at - EPS).sort(byStart);
    if (after.length) {
      const need = at + clip.duration - after[0].start;
      if (need > EPS) for (const o of after) o.start += need;
    }
    return;
  }
  if (isFree(p, tr.id, s, s + clip.duration, clip.id) && !tr.locked) {
    clip.trackId = tr.id;
    clip.start = s;
    return;
  }
  const t2 = findFreeTrack(p, tr.kind, s, s + clip.duration, clip.id);
  clip.trackId = t2.id;
  clip.start = s;
}

// Mueve varios clips (lista de { id, start, trackId }).
export function moveClips(p, moves) {
  const sorted = [...moves].sort((a, b) => a.start - b.start);
  // Aparta primero todos los clips en movimiento para que no choquen entre sí.
  for (const mv of sorted) {
    const c = findClip(p, mv.id);
    if (!c) continue;
    if (c.trackId !== mv.trackId || Math.abs(c.start - mv.start) > EPS) {
      c.transitionIn = null;
      if (c.type === 'audio') c.linkedTo = null; // mover el audio por separado lo desvincula
    }
    c.start = -1e9;
  }
  for (const mv of sorted) {
    const c = findClip(p, mv.id);
    if (c) placeClip(p, c, mv.trackId, mv.start);
  }
}

export function splitClip(p, id, t) {
  const c = findClip(p, id);
  if (!c || t <= c.start + MIN_CLIP / 2 || t >= clipEnd(c) - MIN_CLIP / 2) return null;
  if (c.type === 'audio') c.linkedTo = null;
  const right = clone(c);
  right.id = uid('clip');
  const leftDur = t - c.start;
  right.start = t;
  right.duration = clipEnd(c) - t;
  if (c.type === 'video' || c.type === 'audio') right.in = c.in + leftDur * c.speed;
  right.transitionIn = null;
  right.animIn = { type: 'none', duration: c.animIn?.duration || 0.6 };
  right.fadeIn = 0;
  c.duration = leftDur;
  c.animOut = { type: 'none', duration: c.animOut?.duration || 0.6 };
  c.fadeOut = 0;
  p.clips.push(right);
  // El audio separado del video también se divide y la parte derecha sigue al nuevo clip.
  if (c.type === 'video') {
    for (const la of p.clips.filter((x) => x.type === 'audio' && x.linkedTo === c.id)) {
      const ra = clone(la);
      ra.id = uid('clip');
      ra.linkedTo = right.id;
      ra.fadeIn = 0;
      la.fadeOut = 0;
      p.clips.push(ra);
    }
  }
  return right;
}

export function deleteClips(p, ids, { ripple = false } = {}) {
  const del = p.clips.filter((c) => ids.includes(c.id)).sort((a, b) => b.start - a.start);
  for (const c of del) {
    p.clips = p.clips.filter((x) => x.id !== c.id);
    if (!ripple) continue;
    const list = trackClips(p, c.trackId);
    const following = list.filter((o) => o.start >= c.start - EPS);
    if (!following.length) continue;
    const prevEnd = list.filter((o) => o.start < c.start - EPS).reduce((m, o) => Math.max(m, clipEnd(o)), 0);
    const shift = Math.min(c.duration, following[0].start - prevEnd);
    if (shift > EPS) for (const o of following) o.start -= shift;
  }
}

export function closeGaps(p, trackId) {
  const list = trackClips(p, trackId);
  let pos = 0;
  let prev = null;
  for (const c of list) {
    if (c.transitionIn && prev) c.start = clipEnd(prev) - c.transitionIn.duration;
    else c.start = pos;
    pos = clipEnd(c);
    prev = c;
  }
}

// Aplica (o cambia) la transición de entrada del clip B, solapándolo con el clip anterior.
export function applyTransition(p, clipId, type, duration = 0.6) {
  const b = findClip(p, clipId);
  const main = mainTrack(p);
  if (!b || !main || b.trackId !== main.id || !isVisual(b)) return false;
  const list = trackClips(p, main.id);
  const i = list.findIndex((c) => c.id === b.id);
  const a = list[i - 1];
  if (!a || !isVisual(a)) return false;
  const maxD = Math.max(0.1, Math.min(a.duration - (a.transitionIn?.duration || 0), b.duration) - 0.05);
  const d = clamp(duration, 0.1, maxD);
  const cur = clipEnd(a) - b.start; // solape actual (negativo si hay un hueco entre A y B)
  const shift = d - cur;
  for (const o of list.slice(i)) o.start -= shift;
  b.transitionIn = { type, duration: d };
  return true;
}

export function removeTransition(p, clipId) {
  const b = findClip(p, clipId);
  if (!b || !b.transitionIn) return false;
  const list = trackClips(p, b.trackId);
  const i = list.findIndex((c) => c.id === b.id);
  const d = b.transitionIn.duration;
  for (const o of list.slice(i)) o.start += d;
  b.transitionIn = null;
  return true;
}

// Clip de la pista principal cuya unión (con el anterior) está más cerca del tiempo t.
export function junctionNear(p, t) {
  const main = mainTrack(p);
  if (!main) return null;
  const list = trackClips(p, main.id).filter(isVisual);
  let best = null;
  let bestD = Infinity;
  for (let i = 1; i < list.length; i++) {
    const a = list[i - 1];
    const b = list[i];
    const d = Math.abs((b.start + clipEnd(a)) / 2 - t);
    if (d < bestD) {
      bestD = d;
      best = b;
    }
  }
  return best;
}

export function detachAudio(p, clipId) {
  const c = findClip(p, clipId);
  const m = c && findMedia(p, c.mediaId);
  if (!c || c.type !== 'video' || !m?.hasAudio || c.muted) return null;
  const tr = findFreeTrack(p, 'audio', c.start, clipEnd(c));
  const a = createClip('audio', {
    trackId: tr.id,
    mediaId: c.mediaId,
    name: c.name,
    start: c.start,
    duration: c.duration,
    in: c.in,
    speed: c.speed,
    volume: c.volume,
    fadeIn: c.fadeIn,
    fadeOut: c.fadeOut,
    linkedTo: c.id,
  });
  p.clips.push(a);
  c.muted = true;
  return a;
}

// Devuelve el audio al video: borra el audio separado vinculado y quita el silencio.
export function reattachAudio(p, clipId) {
  const c = findClip(p, clipId);
  if (!c || c.type !== 'video') return false;
  p.clips = p.clips.filter((x) => !(x.type === 'audio' && x.linkedTo === c.id));
  c.muted = false;
  return true;
}

export function duplicateClips(p, ids) {
  const out = [];
  const src = p.clips.filter((c) => ids.includes(c.id)).sort(byStart);
  for (const c of src) {
    const d = clone(c);
    d.id = uid('clip');
    d.transitionIn = null;
    d.linkedTo = null;
    p.clips.push(d);
    d.start = -1e9;
    placeClip(p, d, c.trackId, clipEnd(c));
    out.push(d);
  }
  return out;
}

export function pasteClips(p, items, t) {
  if (!items?.length) return [];
  const minStart = Math.min(...items.map((c) => c.start));
  const out = [];
  for (const it of [...items].sort(byStart)) {
    const d = clone(it);
    d.id = uid('clip');
    d.transitionIn = null;
    d.linkedTo = null;
    if (d.mediaId && !findMedia(p, d.mediaId)) continue;
    let tr = findTrack(p, d.trackId);
    if (!tr || tr.kind !== trackKindFor(d)) tr = trackKindFor(d) === 'audio' ? audioTracks(p)[0] || addTrack(p, 'audio') : mainTrack(p);
    p.clips.push(d);
    d.start = -1e9;
    placeClip(p, d, tr.id, t + (it.start - minStart));
    out.push(d);
  }
  return out;
}

// Congela el fotograma en t: divide el clip e inserta una imagen fija desplazando lo que sigue.
export function insertFreeze(p, clipId, t, imageMediaId, dur = 2) {
  const c = findClip(p, clipId);
  if (!c || c.type !== 'video') return null;
  let right = null;
  if (t > c.start + MIN_CLIP && t < clipEnd(c) - MIN_CLIP) right = splitClip(p, c.id, t);
  const at = right ? right.start : t >= clipEnd(c) - MIN_CLIP ? clipEnd(c) : c.start;
  const following = trackClips(p, c.trackId).filter((o) => o.start >= at - EPS && o.id !== c.id);
  for (const o of following) o.start += dur;
  const img = createClip('image', {
    trackId: c.trackId,
    mediaId: imageMediaId,
    name: 'Fotograma congelado',
    start: at,
    duration: dur,
    transform: clone(c.transform),
    crop: clone(c.crop),
    mask: c.mask,
    adjust: clone(c.adjust),
    filter: c.filter,
  });
  p.clips.push(img);
  return img;
}

// Cambia la duración de un clip. En la pista principal desplaza lo que sigue (como CapCut);
// en las demás solo empuja si se pisaría el siguiente clip.
export function setDuration(p, clipId, dur) {
  const c = findClip(p, clipId);
  if (!c) return;
  const m = c.mediaId ? findMedia(p, c.mediaId) : null;
  const maxD = maxClipDuration(c, m);
  const newDur = clamp(dur, MIN_CLIP, isFinite(maxD) ? maxD : 1e6);
  const delta = newDur - c.duration;
  c.duration = newDur;
  rippleAfter(p, c, delta);
}

// Cambia la velocidad manteniendo el mismo tramo de la fuente (la duración cambia).
export function setSpeed(p, clipId, speed) {
  const c = findClip(p, clipId);
  if (!c || (c.type !== 'video' && c.type !== 'audio')) return;
  const s = clamp(speed, 0.1, 16);
  if (c.type === 'audio') c.linkedTo = null;
  const srcDur = c.duration * c.speed;
  const oldDur = c.duration;
  c.speed = s;
  c.duration = Math.max(MIN_CLIP, srcDur / s);
  rippleAfter(p, c, c.duration - oldDur);
}

function rippleAfter(p, c, delta) {
  if (Math.abs(delta) < EPS) return;
  const following = trackClips(p, c.trackId).filter((o) => o.id !== c.id && o.start > c.start + EPS);
  if (!following.length) return;
  const main = mainTrack(p);
  if (main && c.trackId === main.id) {
    for (const o of following) o.start = Math.max(0, o.start + delta);
  } else if (delta > 0) {
    const push = clipEnd(c) - following[0].start;
    if (push > EPS) for (const o of following) o.start += push;
  }
}

// Recorta (o alarga, con valores negativos) los bordes de un clip: head = segundos que se quitan del principio,
// tail = segundos que se quitan del final. En la pista principal el clip no se mueve y los siguientes se desplazan
// (no quedan huecos); en las demás se mueve el borde izquierdo y nunca se pisa a los clips vecinos.
export function trimClip(p, clipId, { head = 0, tail = 0 } = {}) {
  const c = findClip(p, clipId);
  if (!c) return null;
  const m = c.mediaId ? findMedia(p, c.mediaId) : null;
  const sp = c.speed || 1;
  const hasSource = (c.type === 'video' || c.type === 'audio') && m?.duration > 0;
  const main = mainTrack(p);
  const magnetic = !!main && c.trackId === main.id;
  const list = trackClips(p, c.trackId);
  const i = list.findIndex((x) => x.id === c.id);
  const prevEnd = i > 0 ? Math.min(c.start, clipEnd(list[i - 1])) : 0;
  const nextStart = i < list.length - 1 ? Math.max(clipEnd(c), list[i + 1].start) : Infinity;
  if (c.type === 'audio') c.linkedTo = null; // recortar el audio por separado lo desvincula
  const oldDur = c.duration;
  let h = Number(head) || 0;
  if (hasSource) h = Math.max(h, -c.in / sp);
  if (!magnetic) h = Math.max(h, prevEnd - c.start);
  h = Math.min(h, c.duration - MIN_CLIP);
  if (hasSource) c.in = Math.max(0, c.in + h * sp);
  if (!magnetic) c.start += h;
  c.duration -= h;
  let maxDur = hasSource ? (m.duration - c.in) / sp : Infinity;
  if (!magnetic) maxDur = Math.min(maxDur, nextStart - c.start);
  c.duration = clamp(c.duration - (Number(tail) || 0), MIN_CLIP, Math.max(MIN_CLIP, maxDur));
  if (magnetic) rippleAfter(p, c, c.duration - oldDur);
  return c;
}

// Quita el tramo [s, e) de una pista y junta lo que queda: los clips de esa pista que van después se adelantan.
// El audio separado de los videos sigue a sus trozos (o se elimina con ellos). Las demás pistas no se mueven.
// Una transición que toca el tramo se convierte en un corte. Devuelve los segundos quitados.
export function removeRange(p, trackId, s, e) {
  s = Math.max(0, s);
  const d = e - s;
  if (!(d > EPS) || !findTrack(p, trackId)) return 0;
  const tol = MIN_CLIP / 2; // splitClip no corta tan cerca de un borde
  const before = trackClips(p, trackId);
  for (let i = 1; i < before.length; i++) {
    const a = before[i - 1];
    const b = before[i];
    if (b.transitionIn && b.start < e + tol && clipEnd(a) > s - tol) {
      b.transitionIn = null;
      if (clipEnd(a) > b.start) a.duration = Math.max(MIN_CLIP, b.start - a.start);
    }
  }
  for (const t of [s, e]) {
    for (const c of trackClips(p, trackId)) if (t > c.start + tol && t < clipEnd(c) - tol) splitClip(p, c.id, t);
  }
  const gone = new Set();
  for (const c of trackClips(p, trackId)) {
    const ce = clipEnd(c);
    if (ce <= s + EPS || c.start >= e - EPS) continue;
    if (c.start >= s - tol && ce <= e + tol) gone.add(c.id);
    else if (ce > e + tol) {
      // Empieza (casi) dentro del tramo: se le quita la cabeza.
      const h = e - c.start;
      if (c.type === 'video' || c.type === 'audio') c.in += h * (c.speed || 1);
      c.start = e;
      c.duration = Math.max(MIN_CLIP, c.duration - h);
    } else {
      c.duration = Math.max(MIN_CLIP, s - c.start); // termina un poco dentro: se le quita la cola
    }
  }
  for (const a of p.clips) if (a.type === 'audio' && a.linkedTo && gone.has(a.linkedTo)) gone.add(a.id);
  p.clips = p.clips.filter((c) => !gone.has(c.id));
  for (const c of trackClips(p, trackId)) if (c.start >= e - EPS) c.start = Math.max(0, c.start - d);
  return d;
}

// ---------- Tramos de tiempo ({ start, end } en segundos) ----------

export function mergeRanges(ranges, gap = 1e-3) {
  const out = [];
  for (const r of [...ranges].filter((x) => x.end > x.start).sort((a, b) => a.start - b.start)) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end + gap) last.end = Math.max(last.end, r.end);
    else out.push({ start: r.start, end: r.end });
  }
  return out;
}

// Resta a cada tramo las zonas protegidas.
export function subtractRanges(ranges, cuts) {
  let out = mergeRanges(ranges);
  for (const z of mergeRanges(cuts)) {
    const next = [];
    for (const r of out) {
      if (z.end <= r.start || z.start >= r.end) next.push(r);
      else {
        if (z.start > r.start) next.push({ start: r.start, end: z.start });
        if (z.end < r.end) next.push({ start: z.end, end: r.end });
      }
    }
    out = next;
  }
  return out;
}

// Convierte tramos de la fuente (segundos del archivo) en tramos de la línea de tiempo dentro de un clip.
// margin acerca los bordes hacia dentro donde hay contenido al otro lado (p. ej. para no cortar el inicio de una palabra).
export function sourceRangesToTimeline(clip, ranges, { margin = 0, minLength = 0 } = {}) {
  const sp = clip.speed || 1;
  const s0 = clip.in || 0;
  const s1 = s0 + clip.duration * sp;
  const out = [];
  for (const r of ranges) {
    const a = Math.max(r.start, s0);
    const b = Math.min(r.end, s1);
    if (b <= a) continue;
    let ts = clip.start + (a - s0) / sp;
    let te = clip.start + (b - s0) / sp;
    if (a > s0 + 1e-3) ts += margin;
    if (b < s1 - 1e-3) te -= margin;
    if (te - ts > Math.max(EPS, minLength)) out.push({ start: ts, end: te });
  }
  return out;
}

// Zonas de la pista principal donde hay una transición (se solapan dos clips).
export function transitionZones(p, trackId) {
  const list = trackClips(p, trackId);
  const out = [];
  for (let i = 1; i < list.length; i++) {
    const end = clipEnd(list[i - 1]);
    if (list[i].transitionIn && end > list[i].start) out.push({ start: list[i].start, end });
  }
  return out;
}

export function removeTrack(p, trackId) {
  const tr = findTrack(p, trackId);
  if (!tr) return false;
  if (tr.kind === 'video' && videoTracks(p).length <= 1) return false;
  p.clips = p.clips.filter((c) => c.trackId !== trackId);
  p.tracks = p.tracks.filter((t) => t.id !== trackId);
  return true;
}

// Añade un clip de un medio: video/imagen al final de la pista principal, audio en el cursor.
export function addMediaClip(p, media, { t = 0, trackId = null, start = null, imageDuration = 5 } = {}) {
  const type = media.kind;
  const clip = createClip(type, { mediaId: media.id, name: media.name });
  clip.duration = type === 'image' ? imageDuration : Math.max(MIN_CLIP, media.duration || imageDuration);
  if (type === 'audio') {
    const s = start ?? t;
    const tr = trackId && findTrack(p, trackId)?.kind === 'audio' ? findTrack(p, trackId) : findFreeTrack(p, 'audio', s, s + clip.duration);
    p.clips.push(clip);
    clip.start = -1e9;
    placeClip(p, clip, tr.id, s);
    return clip;
  }
  const main = mainTrack(p);
  let tr = trackId ? findTrack(p, trackId) : main;
  if (!tr || tr.kind !== 'video') tr = main;
  const s = start ?? (tr.id === main.id ? trackClips(p, main.id).reduce((m, c) => Math.max(m, clipEnd(c)), 0) : t);
  p.clips.push(clip);
  clip.start = -1e9;
  placeClip(p, clip, tr.id, s);
  return clip;
}
