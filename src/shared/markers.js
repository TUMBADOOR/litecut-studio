// Marcadores de la línea de tiempo: los que pone el usuario (tecla M) y los pulsos de una canción («beat»).
// Sirven de referencia y el imán se pega a ellos, para cortar y colocar clips al ritmo de la música.
import { uid } from './model.js';

// Pone un marcador del usuario en t, o lo quita si ya hay uno a menos de medio fotograma.
export function toggleMarker(p, t, fps = 30) {
  p.markers ||= [];
  const near = p.markers.find((m) => m.kind === 'user' && Math.abs(m.t - t) < 0.5 / fps);
  if (near) {
    p.markers = p.markers.filter((m) => m !== near);
    return null;
  }
  const m = { id: uid('mk'), t: Math.max(0, t), kind: 'user' };
  p.markers = [...p.markers, m].sort((a, b) => a.t - b.t);
  return m;
}

export function removeMarkers(p, ids) {
  const set = new Set(ids);
  p.markers = (p.markers || []).filter((m) => !set.has(m.id));
}

// Sustituye los pulsos que hubiera entre a y b por los nuevos (instantes de la línea de tiempo).
export function setBeatMarkers(p, times, a, b) {
  const kept = (p.markers || []).filter((m) => m.kind !== 'beat' || m.t < a - 1e-3 || m.t > b + 1e-3);
  p.markers = [...kept, ...times.map((t) => ({ id: uid('mk'), t, kind: 'beat' }))].sort((x, y) => x.t - y.t);
}

export function clearBeatMarkers(p) {
  p.markers = (p.markers || []).filter((m) => m.kind !== 'beat');
}

// Pulsos de un clip de audio en la línea de tiempo: los del archivo, pasados por su punto de entrada y velocidad.
export function beatsToTimeline(clip, beats) {
  const sp = clip.speed || 1;
  const end = clip.start + clip.duration;
  return beats.map((b) => clip.start + (b - clip.in) / sp).filter((t) => t >= clip.start - 1e-3 && t <= end + 1e-3);
}
