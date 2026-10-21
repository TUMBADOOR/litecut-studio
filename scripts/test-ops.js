// Pruebas de las operaciones de edición (sin interfaz). Uso: node scripts/test-ops.js
import assert from 'node:assert/strict';
import { createProject, createClip, clipEnd, trackClips, mainTrack } from '../src/shared/model.js';
import * as ops from '../src/shared/ops.js';
import { mainTrackItems } from '../src/shared/layout.js';
import { mainTrackFrames } from '../src/shared/export-graph.js';

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

console.log(process.exitCode ? '\nHay pruebas que fallaron' : `\n${passed} pruebas correctas`);
