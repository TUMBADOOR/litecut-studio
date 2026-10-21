// Geometría compartida entre la vista previa y la exportación.
import { clipEnd, trackClips, videoTracks, mainTrack, isVisual } from './model.js';
import { clipMotion, transitionFx, emptyMotion } from './effects.js';

// Rectángulo de recorte en píxeles de la fuente.
export function cropRect(clip, media) {
  const c = clip.crop || { l: 0, t: 0, r: 0, b: 0 };
  const W = media?.width || 2;
  const H = media?.height || 2;
  const l = Math.max(0, Math.min(0.95, c.l || 0));
  const t = Math.max(0, Math.min(0.95, c.t || 0));
  const r = Math.max(0, Math.min(0.95 - l, c.r || 0));
  const b = Math.max(0, Math.min(0.95 - t, c.b || 0));
  return { x: W * l, y: H * t, w: Math.max(2, W * (1 - l - r)), h: Math.max(2, H * (1 - t - b)) };
}

export const hasCrop = (clip) => {
  const c = clip.crop || {};
  return (c.l || 0) > 0.0005 || (c.t || 0) > 0.0005 || (c.r || 0) > 0.0005 || (c.b || 0) > 0.0005;
};

// Tamaño base de la capa (px del proyecto), antes de rotación y animaciones.
// Para texto se pasa textSize = tamaño del texto renderizado a escala 1.
export function layerSize(clip, media, PW, PH, textSize) {
  const s = clip.transform?.scale || 1;
  if (clip.type === 'text') return { w: (textSize?.w || 1) * s, h: (textSize?.h || 1) * s };
  const r = cropRect(clip, media);
  const fit = Math.min(PW / r.w, PH / r.h);
  return { w: r.w * fit * s, h: r.h * fit * s };
}

// Clips de la pista principal ordenados, con solapes de transición saneados (en segundos).
export function mainTrackItems(project) {
  const base = mainTrack(project);
  if (!base) return [];
  const list = trackClips(project, base.id).filter(isVisual);
  const items = list.map((clip) => ({ clip, start: clip.start, end: clipEnd(clip), head: 0, tail: 0, transition: null }));
  for (let i = 1; i < items.length; i++) {
    const a = items[i - 1];
    const b = items[i];
    const overlap = a.end - b.start;
    if (overlap > 1e-6) {
      if (b.clip.transitionIn) {
        const maxOv = Math.min(a.end - a.start - a.head, b.end - b.start);
        const ov = Math.max(0, Math.min(overlap, maxOv));
        if (ov < overlap) a.end = b.start + ov;
        if (ov > 1e-6) {
          a.tail = ov;
          b.head = ov;
          b.transition = b.clip.transitionIn.type || 'fade';
        }
      } else {
        a.end = b.start; // solape sin transición: corta el clip anterior
      }
    }
  }
  return items;
}

// Qué se dibuja en la pista principal en el tiempo t. Devuelve marcos con su movimiento de transición.
export function mainFramesAt(items, t, PW, PH) {
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (t < it.start || t >= it.end) continue;
    const next = items[i + 1];
    if (next && next.head > 0 && t >= next.start && t < it.end) {
      const u = t - next.start;
      const fx = transitionFx(next.transition, next.head, PW, PH);
      const fa = { item: it, motion: fx.A, u };
      const fb = { item: next, motion: fx.B, u };
      return fx.top === 'A' ? [fb, fa] : [fa, fb];
    }
    return [{ item: it, motion: emptyMotion(), u: 0 }];
  }
  return [];
}

// Clips de las pistas superiores activos en t, de abajo hacia arriba.
export function overlayClipsAt(project, t) {
  const tracks = videoTracks(project).slice(0, -1).reverse();
  const out = [];
  for (const tr of tracks) {
    if (tr.hidden) continue;
    for (const c of trackClips(project, tr.id)) {
      if (!isVisual(c)) continue;
      if (t >= c.start && t < clipEnd(c)) out.push(c);
    }
  }
  return out;
}

export function clipLocalMotion(clip, PW, PH) {
  return clipMotion(clip, clip.duration, PW, PH);
}
