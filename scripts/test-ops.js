// Pruebas de las operaciones de edición (sin interfaz). Uso: node scripts/test-ops.js
import assert from 'node:assert/strict';
import { createProject, createClip, clipEnd, trackClips, mainTrack } from '../src/shared/model.js';
import * as ops from '../src/shared/ops.js';
import { mainTrackItems } from '../src/shared/layout.js';
import { mainTrackFrames } from '../src/shared/export-graph.js';
import { usedRanges, uncoveredRanges, addPart } from '../src/shared/proxy-ranges.js';
import { analyzeBeats } from '../src/shared/beats.js';
import { toggleMarker, setBeatMarkers, beatsToTimeline } from '../src/shared/markers.js';
import { clipMotion, evalMotion, ffMotionExprs, flashAlpha, beatGridFor } from '../src/shared/effects.js';

// Evalúa una expresión de FFmpeg (las que generan los efectos) en el instante t, traduciéndola a JavaScript.
function ffEval(expr, t) {
  const js = expr
    .replace(/\\,/g, ',')
    .replace(/\bPI\b/g, 'Math.PI')
    .replace(/\b(sin|exp|pow)\(/g, 'Math.$1(')
    .replace(/\bbetween\(/g, '__between(')
    .replace(/\bmod\(/g, '__mod(')
    .replace(/\bclip\(/g, '__clip(');
  // eslint-disable-next-line no-new-func
  return new Function('t', '__between', '__mod', '__clip', `return ${js};`)(
    t,
    (x, a, b) => (x >= a && x <= b ? 1 : 0),
    (x, y) => x - y * Math.floor(x / y),
    (x, a, b) => Math.min(b, Math.max(a, x))
  );
}

let passed = 0;
const test = (name, fn) => {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.log(`  ✗ ${name}\n    ${err.message}`);
    process.exitCode = 1;
  }
};

function setup() {
  const p = createProject('16:9');
  p.media = [
    { id: 'v', kind: 'video', path: 'v.mp4', duration: 10, width: 1920, height: 1080, hasAudio: true },
    { id: 'a', kind: 'audio', path: 'a.mp3', duration: 30, width: 0, height: 0, hasAudio: true },
    { id: 'i', kind: 'image', path: 'i.png', duration: 0, width: 800, height: 800 },
  ];
  return p;
}
const main = (p) => trackClips(p, mainTrack(p).id);
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

console.log('Operaciones de edición:');

test('añadir videos se colocan seguidos en la pista principal', () => {
  const p = setup();
  ops.addMediaClip(p, p.media[0]);
  ops.addMediaClip(p, p.media[0]);
  ops.addMediaClip(p, p.media[2]);
  ops.sanitizeProject(p);
  const l = main(p);
  assert.equal(l.length, 3);
  near(l[0].start, 0);
  near(l[1].start, 10);
  near(l[2].start, 20);
  near(l[2].duration, 5);
});

test('insertar en medio de un clip desplaza los siguientes', () => {
  const p = setup();
  ops.addMediaClip(p, p.media[0]);
  ops.addMediaClip(p, p.media[0]);
  const img = ops.addMediaClip(p, p.media[2], { start: 3 });
  ops.sanitizeProject(p);
  const l = main(p);
  assert.equal(l[0].id, img.id); // 3 s está antes de la mitad del clip: se inserta delante
  near(img.start, 0, 1e-6);
  near(l[1].start, 5);
  near(l[2].start, 15);
});

test('el audio va a una pista de audio libre', () => {
  const p = setup();
  const a1 = ops.addMediaClip(p, p.media[1], { start: 2 });
  const a2 = ops.addMediaClip(p, p.media[1], { start: 5 });
  ops.sanitizeProject(p);
  assert.notEqual(a1.trackId, a2.trackId);
  assert.equal(p.tracks.filter((t) => t.kind === 'audio').length, 2);
});

test('dividir conserva el tramo de la fuente', () => {
  const p = setup();
  const c = ops.addMediaClip(p, p.media[0]);
  c.in = 1;
  c.duration = 8;
  const r = ops.splitClip(p, c.id, 3);
  near(c.duration, 3);
  near(r.start, 3);
  near(r.duration, 5);
  near(r.in, 4);
});

test('transición: solapa y desplaza, y quitarla lo revierte', () => {
  const p = setup();
  ops.addMediaClip(p, p.media[0]);
  const b = ops.addMediaClip(p, p.media[0]);
  const c = ops.addMediaClip(p, p.media[0]);
  ops.applyTransition(p, b.id, 'fade', 1);
  ops.sanitizeProject(p);
  near(b.start, 9);
  near(c.start, 19);
  assert.equal(b.transitionIn.type, 'fade');
  ops.applyTransition(p, b.id, 'slide-left', 0.5);
  ops.sanitizeProject(p);
  near(b.start, 9.5);
  near(c.start, 19.5);
  ops.removeTransition(p, b.id);
  ops.sanitizeProject(p);
  near(b.start, 10);
  near(c.start, 20);
  assert.equal(b.transitionIn, null);
});

test('transición con hueco: cierra el hueco', () => {
  const p = setup();
  ops.addMediaClip(p, p.media[0]);
  const b = ops.addMediaClip(p, p.media[0], { start: 12 });
  ops.applyTransition(p, b.id, 'fade', 1);
  ops.sanitizeProject(p);
  near(b.start, 9);
});

test('mover un clip lejos elimina su transición', () => {
  const p = setup();
  ops.addMediaClip(p, p.media[0]);
  const b = ops.addMediaClip(p, p.media[0]);
  ops.applyTransition(p, b.id, 'fade', 1);
  ops.moveClips(p, [{ id: b.id, start: 30, trackId: b.trackId }]);
  ops.sanitizeProject(p);
  assert.equal(b.transitionIn, null);
  near(b.start, 30);
});

test('eliminar y cerrar hueco', () => {
  const p = setup();
  const a = ops.addMediaClip(p, p.media[0]);
  const b = ops.addMediaClip(p, p.media[2]);
  const c = ops.addMediaClip(p, p.media[0]);
  ops.deleteClips(p, [b.id], { ripple: true });
  near(c.start, 10);
  assert.ok(!p.clips.includes(b));
  void a;
});

test('velocidad 2× acorta el clip y desplaza los siguientes en la principal', () => {
  const p = setup();
  const a = ops.addMediaClip(p, p.media[0]);
  const b = ops.addMediaClip(p, p.media[2]);
  ops.setSpeed(p, a.id, 2);
  near(a.duration, 5);
  near(b.start, 5);
  ops.setSpeed(p, a.id, 0.5);
  near(a.duration, 20);
  near(b.start, 20);
});

test('la duración no supera la fuente', () => {
  const p = setup();
  const a = ops.addMediaClip(p, p.media[0]);
  ops.setDuration(p, a.id, 50);
  near(a.duration, 10);
});

test('separar audio crea un clip de audio y silencia el video', () => {
  const p = setup();
  const v = ops.addMediaClip(p, p.media[0]);
  const a = ops.detachAudio(p, v.id);
  assert.equal(a.type, 'audio');
  assert.equal(v.muted, true);
  near(a.start, v.start);
  near(a.duration, v.duration);
});

test('el audio separado sigue a su video al moverlo y cambiar la velocidad', () => {
  const p = setup();
  const v = ops.addMediaClip(p, p.media[0]);
  const a = ops.detachAudio(p, v.id);
  ops.moveClips(p, [{ id: v.id, start: 4, trackId: v.trackId }]);
  ops.sanitizeProject(p);
  near(a.start, 4);
  ops.setSpeed(p, v.id, 2);
  ops.sanitizeProject(p);
  near(a.duration, 5);
  near(a.speed, 2);
});

test('dividir un video divide también su audio vinculado', () => {
  const p = setup();
  const v = ops.addMediaClip(p, p.media[0]);
  const a = ops.detachAudio(p, v.id);
  const right = ops.splitClip(p, v.id, 3);
  ops.sanitizeProject(p);
  const audios = p.clips.filter((c) => c.type === 'audio');
  assert.equal(audios.length, 2);
  const ra = audios.find((x) => x.id !== a.id);
  assert.equal(ra.linkedTo, right.id);
  near(a.duration, 3);
  near(ra.start, 3);
  near(ra.in, 3);
});

test('mover el audio por separado lo desvincula', () => {
  const p = setup();
  const v = ops.addMediaClip(p, p.media[0]);
  const a = ops.detachAudio(p, v.id);
  ops.moveClips(p, [{ id: a.id, start: 2, trackId: a.trackId }]);
  ops.sanitizeProject(p);
  assert.equal(a.linkedTo, null);
  near(a.start, 2);
});

test('devolver el audio elimina el clip separado', () => {
  const p = setup();
  const v = ops.addMediaClip(p, p.media[0]);
  ops.detachAudio(p, v.id);
  ops.reattachAudio(p, v.id);
  assert.equal(p.clips.filter((c) => c.type === 'audio').length, 0);
  assert.equal(v.muted, false);
});

test('congelar fotograma inserta 2 s y desplaza', () => {
  const p = setup();
  const v = ops.addMediaClip(p, p.media[0]);
  const after = ops.addMediaClip(p, p.media[2]);
  const img = ops.insertFreeze(p, v.id, 4, 'i', 2);
  ops.sanitizeProject(p);
  const l = main(p);
  assert.equal(l.length, 4);
  near(img.start, 4);
  near(l[2].start, 6);
  near(after.start, 12);
});

test('pegar coloca los clips en el cursor', () => {
  const p = setup();
  const v = ops.addMediaClip(p, p.media[0]);
  const out = ops.pasteClips(p, [JSON.parse(JSON.stringify(v))], 10);
  near(out[0].start, 10);
  assert.notEqual(out[0].id, v.id);
});

test('sanear: transición fuera de la principal se elimina', () => {
  const p = setup();
  const t = ops.addTrack(p, 'video');
  const c = createClip('image', { mediaId: 'i', trackId: t.id, start: 0, duration: 3, transitionIn: { type: 'fade', duration: 1 } });
  p.clips.push(c);
  ops.sanitizeProject(p);
  assert.equal(c.transitionIn, null);
});

test('marcos de exportación coinciden con la vista previa', () => {
  const p = setup();
  ops.addMediaClip(p, p.media[0]);
  const b = ops.addMediaClip(p, p.media[0]);
  ops.addMediaClip(p, p.media[2]);
  ops.applyTransition(p, b.id, 'fade', 0.5);
  ops.sanitizeProject(p);
  const items = mainTrackItems(p);
  const frames = mainTrackFrames(p, 30);
  assert.equal(items.length, frames.length);
  for (let i = 0; i < items.length; i++) {
    near(frames[i].s / 30, items[i].start, 1 / 30);
    near(frames[i].e / 30, items[i].end, 1 / 30);
  }
  assert.equal(frames[1].head, 15);
  assert.equal(frames[0].tail, 15);
});

test('el final del proyecto incluye todas las pistas', () => {
  const p = setup();
  ops.addMediaClip(p, p.media[0]);
  ops.addMediaClip(p, p.media[1], { start: 0 });
  ops.sanitizeProject(p);
  near(Math.max(...p.clips.map(clipEnd)), 30);
});

test('copias ligeras: tramos usados con margen, unidos si están cerca y sin los ya cubiertos', () => {
  const clips = [
    { mediaId: 'v', in: 0, duration: 1, speed: 1 },
    { mediaId: 'v', in: 1.3, duration: 16, speed: 0.5 }, // usa 1,3–9,3 s del archivo
    { mediaId: 'v', in: 8.4, duration: 6.3, speed: 1 },
    { mediaId: 'v', in: 120.5, duration: 4, speed: 1 },
    { mediaId: 'x', in: 50, duration: 4, speed: 1 },
  ];
  const r = usedRanges(clips, 'v', 154);
  assert.deepEqual(r, [
    [0, 17],
    [118, 127],
  ]);
  assert.deepEqual(uncoveredRanges(r, [{ start: 0, end: 19 }]), [[118, 127]]);
  assert.deepEqual(uncoveredRanges(r, [{ start: 2, end: 19 }]), r); // una parte que no cubre entero no sirve
  assert.deepEqual(usedRanges([{ mediaId: 'v', in: 152, duration: 5, speed: 1 }], 'v', 154), [[150, 154]]);
  const parts = addPart([{ start: 0, end: 10 }, { start: 118, end: 127 }], { start: 0, end: 19 });
  assert.deepEqual(parts.map((p) => [p.start, p.end]), [
    [0, 19],
    [118, 127],
  ]);
});

// Pista de clics a bpm (con algo de ruido) para probar la detección de ritmo.
function clickTrack(bpm, secs, rate = 8000, offset = 0.13) {
  const s = new Float32Array(rate * secs);
  let seed = 7;
  for (let i = 0; i < s.length; i++) s[i] = 0.05 * (((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1);
  for (let k = 0, t = offset; t < secs; k++, t = offset + (k * 60) / bpm) {
    const i0 = Math.round(t * rate);
    for (let i = 0; i < 400 && i0 + i < s.length; i++) s[i0 + i] += Math.sin(i * 0.9) * Math.exp(-i / 60) * (k % 4 ? 0.6 : 1);
  }
  return s;
}

test('ritmo: encuentra el tempo y los golpes de una pista de clics (±1 fotograma)', () => {
  for (const bpm of [90, 128, 140]) {
    const r = analyzeBeats(clickTrack(bpm, 20), 8000);
    assert.ok(Math.abs(r.bpm - bpm) < 1.5, `${bpm} BPM → ${r.bpm}`);
    const P = 60 / bpm;
    for (const b of r.beats) {
      const k = Math.round((b - 0.13) / P);
      assert.ok(Math.abs(b - 0.13 - k * P) < 1 / 60, `pulso desalineado ${b.toFixed(3)} s a ${bpm} BPM`);
    }
    assert.ok(r.beats.length >= (20 / P) * 0.9, `faltan pulsos a ${bpm} BPM: ${r.beats.length}`);
  }
  assert.deepEqual(analyzeBeats(new Float32Array(8000 * 5), 8000), { bpm: 0, beats: [] });
  // Sin golpes (tono continuo) o sin regularidad (ruido): no se inventan pulsos.
  const tone = new Float32Array(8000 * 8).map((_, i) => 0.3 * Math.sin((2 * Math.PI * 220 * i) / 8000));
  assert.deepEqual(analyzeBeats(tone, 8000), { bpm: 0, beats: [] });
  let seed = 3;
  const noise = new Float32Array(8000 * 8).map(() => 0.3 * (((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1));
  assert.deepEqual(analyzeBeats(noise, 8000), { bpm: 0, beats: [] });
});

test('marcadores: M pone y quita; los de ritmo se reemplazan en el tramo del clip', () => {
  const p = setup();
  const m = toggleMarker(p, 2, 30);
  assert.ok(m && p.markers.length === 1);
  assert.equal(toggleMarker(p, 2.01, 30), null);
  assert.equal(p.markers.length, 0);
  toggleMarker(p, 1, 30);
  const clip = { start: 10, duration: 4, in: 3, speed: 2 };
  const tl = beatsToTimeline(clip, [2, 3, 5, 7, 11, 12]); // fuente 3–11 s → línea de tiempo 10–14 s
  assert.deepEqual(tl, [10, 11, 12, 14]);
  setBeatMarkers(p, tl, 10, 14);
  setBeatMarkers(p, [10.5, 13.5], 10, 14);
  assert.deepEqual(p.markers.map((x) => [x.t, x.kind]), [
    [1, 'user'],
    [10.5, 'beat'],
    [13.5, 'beat'],
  ]);
});

test('efectos: temblor, impacto, golpe de zoom, pulso y destello se evalúan como en la exportación', () => {
  const clip = { animIn: { type: 'none' }, animOut: { type: 'none' }, kenburns: 'none', effects: [] };
  clip.effects = [{ type: 'shake', intensity: 0.5 }];
  let m = clipMotion(clip, 4, 1920, 1080);
  const shake = [0.1, 0.37, 1.2, 3.9].map((t) => evalMotion(m, t));
  assert.ok(shake.some((e) => Math.abs(e.dx) > 3) && shake.every((e) => Math.abs(e.dx) <= 0.5 * 0.035 * 1080 + 1e-9), 'el temblor se mueve dentro de su amplitud');
  assert.ok(shake.every((e) => e.scale > 1), 'el temblor amplía un poco para no ver bordes');
  clip.effects = [{ type: 'impact', intensity: 1 }];
  m = clipMotion(clip, 4, 1920, 1080);
  assert.ok(Math.abs(evalMotion(m, 0.05).dx) + Math.abs(evalMotion(m, 0.05).dy) > Math.abs(evalMotion(m, 0.9).dx) + Math.abs(evalMotion(m, 0.9).dy), 'el impacto se calma');
  near(evalMotion(m, 2).dx, 0);
  clip.effects = [{ type: 'zoom-hit', intensity: 1 }];
  m = clipMotion(clip, 4, 1920, 1080);
  near(evalMotion(m, 0).scale, 1.3);
  assert.ok(evalMotion(m, 0.5).scale < 1.02);
  near(evalMotion(m, 2).scale, 1);
  clip.effects = [{ type: 'zoom-pulse', intensity: 1, period: 0.5, phase: 0.1 }];
  m = clipMotion(clip, 4, 1920, 1080);
  near(evalMotion(m, 0.1).scale, 1.12);
  near(evalMotion(m, 2.6).scale, 1.12);
  assert.ok(evalMotion(m, 0.35).scale < 1.02);
  // Mismos números en las expresiones de FFmpeg (se evalúan aquí reemplazando las funciones de FFmpeg).
  for (const fx of [{ type: 'shake', intensity: 0.7 }, { type: 'impact', intensity: 0.4 }, { type: 'zoom-pulse', intensity: 0.8, period: 0.47, phase: 0.2 }]) {
    clip.effects = [fx];
    m = clipMotion(clip, 3, 1280, 720);
    const ex = ffMotionExprs(m, 't', 0.5);
    for (const t of [0, 0.13, 0.5, 1.77, 2.9]) {
      const ev = evalMotion(m, t);
      if (ex.dx) near(ffEval(ex.dx, t), ev.dx * 0.5, 1e-3);
      if (ex.dy) near(ffEval(ex.dy, t), ev.dy * 0.5, 1e-3);
      if (ex.scale) near(ffEval(ex.scale, t), ev.scale, 1e-4);
    }
  }
  clip.effects = [{ type: 'flash', intensity: 0.8 }];
  near(flashAlpha(clip, 0), 0.8);
  near(flashAlpha(clip, 0.15), 0.4);
  near(flashAlpha(clip, 0.35), 0);
  assert.deepEqual(beatGridFor({ start: 10, duration: 4 }, [10.2, 10.7, 11.2, 11.7, 20].map((t) => ({ t, kind: 'beat' }))), { period: 0.5, phase: 0.2 });
});

console.log(process.exitCode ? '\nHay pruebas que fallaron' : `\n${passed} pruebas correctas`);
