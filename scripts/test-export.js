// Prueba del motor de exportación: genera medios sintéticos con FFmpeg, arma proyectos
// con transiciones, textos, máscaras, filtros y audio, y verifica que FFmpeg los exporte.
// Uso: node scripts/test-export.js [carpeta-de-trabajo] [--quick]
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runFfmpeg, probe, ffmpegVersion, filterScriptArgs, encoderArgs, lastLines, listKeyframes, extractThumbs, reverseRange, measureLoudness, extractPcm } from '../src/main/ffmpeg.js';
import { analyzeBeats } from '../src/shared/beats.js';
import { buildExportGraph } from '../src/shared/export-graph.js';
import { createProject, createClip, createTrack } from '../src/shared/model.js';
import { TRANSITIONS, FILTER_PRESETS } from '../src/shared/effects.js';

const args = process.argv.slice(2);
const quick = args.includes('--quick');
const dir = args.find((a) => !a.startsWith('--')) || path.join(os.tmpdir(), 'litecut-test');
fs.mkdirSync(dir, { recursive: true });

const version = await ffmpegVersion();
console.log('FFmpeg:', version.text);

async function gen(name, a) {
  const out = path.join(dir, name);
  if (!fs.existsSync(out)) {
    const r = await runFfmpeg(['-hide_banner', '-y', ...a, out]);
    if (r.code) throw new Error(`No se pudo generar ${name}\n${lastLines(r.stderr)}`);
  }
  return out;
}

const files = {
  v1: await gen('v1.mp4', ['-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=30:d=6', '-f', 'lavfi', '-i', 'sine=f=440:d=6', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest']),
  v2: await gen('v2.mp4', ['-f', 'lavfi', '-i', 'smptebars=s=640x480:r=25:d=5', '-f', 'lavfi', '-i', 'sine=f=660:d=5', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest']),
  img: await gen('img.png', ['-f', 'lavfi', '-i', 'testsrc=s=800x800:d=1', '-frames:v', '1']),
  music: await gen('music.mp3', ['-f', 'lavfi', '-i', 'sine=f=220:d=8', '-c:a', 'libmp3lame']),
  text: await gen('text.png', ['-f', 'lavfi', '-i', 'color=c=white@0.85:s=420x110,format=rgba', '-frames:v', '1']),
};

async function mediaEntry(id, file, kind) {
  const info = await probe(file);
  return { id, path: file, name: path.basename(file), kind, duration: kind === 'image' ? 0 : info.duration, width: info.width, height: info.height, hasAudio: info.hasAudio, hasVideo: info.hasVideo, start: info.start || 0, container: info.container };
}

// Cuenta los fotogramas de video reales (la duración del contenedor puede venir solo del audio).
async function countFrames(file) {
  let out = '';
  await runFfmpeg(['-hide_banner', '-nostdin', '-i', file, '-map', '0:v:0', '-f', 'null', '-'], { onLine: (l) => (out = /frame=\s*(\d+)/.test(l) ? l : out) });
  const m = /frame=\s*(\d+)/.exec(out);
  return m ? +m[1] : 0;
}

const media = [
  await mediaEntry('m1', files.v1, 'video'),
  await mediaEntry('m2', files.v2, 'video'),
  await mediaEntry('mi', files.img, 'image'),
  await mediaEntry('ma', files.music, 'audio'),
];

function baseProject() {
  const p = createProject('16:9');
  p.settings.width = 1280;
  p.settings.height = 720;
  p.settings.fps = 30;
  p.media = media;
  return p;
}

async function exportProject(p, name, { width = 640, height = 360, format = 'mp4', fps = 30, assets = {}, movie = false } = {}) {
  const gif = format === 'gif';
  const audioOnly = format === 'mp3' || format === 'wav';
  const graph = buildExportGraph(p, { width, height, fps, gif, includeVideo: !audioOnly, includeAudio: !gif, movieSources: movie }, assets);
  const enc = encoderArgs({ format, quality: 'low', width, height, fps, hw: null });
  const out = path.join(dir, `${name}.${enc.ext}`);
  const script = path.join(dir, `${name}.filter.txt`);
  fs.writeFileSync(script, graph.filter);
  const a = ['-hide_banner', '-y', '-nostdin', ...graph.inputs.flat(), ...filterScriptArgs(version, script)];
  if (graph.vout) a.push('-map', graph.vout, ...enc.video, '-r', String(fps));
  if (graph.aout) a.push('-map', graph.aout, ...enc.audio);
  a.push(...enc.extra, '-t', graph.total.toFixed(3), out);
  const t0 = Date.now();
  const r = await runFfmpeg(a);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  if (r.code !== 0) {
    console.log(`  ✗ ${name} (${secs}s)\n${lastLines(r.stderr, 20)}`);
    return false;
  }
  const info = await probe(out);
  const okDur = Math.abs(info.duration - graph.total) < 0.25 || (gif && info.duration > 0);
  let okFrames = true;
  let framesTxt = '';
  if (!audioOnly && !gif) {
    const n = await countFrames(out);
    okFrames = Math.abs(n - graph.frames) <= 1;
    framesTxt = ` ${n}/${graph.frames} fotogramas`;
  }
  const ok = okDur && okFrames;
  console.log(`  ${ok ? '✓' : '✗'} ${name}: ${info.duration.toFixed(2)}s (esperado ${graph.total.toFixed(2)}s)${framesTxt} ${info.width}x${info.height} en ${secs}s`);
  return ok;
}

let failures = 0;
const check = (ok) => {
  if (!ok) failures++;
};

// ---------- Proyecto completo ----------
{
  const p = baseProject();
  const [V1, A1] = p.tracks;
  const V2 = createTrack('video');
  p.tracks.unshift(V2);
  const c1 = createClip('video', { trackId: V1.id, mediaId: 'm1', start: 0, duration: 4, in: 1 });
  const c2 = createClip('video', { trackId: V1.id, mediaId: 'm2', start: 3.5, duration: 3, transitionIn: { type: 'fade', duration: 0.5 } });
  c2.adjust.saturation = 50;
  c2.adjust.vignette = 40;
  const c3 = createClip('image', { trackId: V1.id, mediaId: 'mi', start: 6, duration: 3, kenburns: 'zoom-in', transitionIn: { type: 'slide-left', duration: 0.5 } });
  const c4 = createClip('video', { trackId: V1.id, mediaId: 'm1', start: 10, duration: 2, speed: 2, fadeIn: 0.3 });
  Object.assign(c4.adjust, FILTER_PRESETS.find((f) => f.id === 'vintage').adjust);
  const t1 = createClip('text', { trackId: V2.id, start: 1, duration: 3, animIn: { type: 'fade', duration: 0.5 }, animOut: { type: 'slide-right', duration: 0.5 } });
  t1.transform.y = 200;
  const pip = createClip('image', { trackId: V2.id, mediaId: 'mi', start: 5, duration: 3, mask: 'circle', animIn: { type: 'zoom-in', duration: 0.6 } });
  Object.assign(pip.transform, { scale: 0.4, x: 300, y: -150, rotation: 15, opacity: 0.9 });
  pip.adjust.vignette = 50;
  const pip2 = createClip('video', { trackId: V2.id, mediaId: 'm2', start: 9, duration: 2.5, mask: 'rounded', crop: { l: 0.1, t: 0.1, r: 0.1, b: 0.1 } });
  Object.assign(pip2.transform, { scale: 0.35, x: -350, y: 180, flipH: true });
  pip2.animOut = { type: 'zoom-out', duration: 0.5 };
  const music = createClip('audio', { trackId: A1.id, mediaId: 'ma', start: 0, duration: 8, fadeIn: 1, fadeOut: 2, volume: 0.5 });
  p.clips = [c1, c2, c3, c4, t1, pip, pip2, music];
  const assets = { text: { [t1.id]: { path: files.text, w: 210, h: 56 } } };
  console.log('Proyecto completo:');
  check(await exportProject(p, 'completo', { assets }));
  check(await exportProject(p, 'completo-movie', { assets, movie: true }));
  if (!quick) {
    check(await exportProject(p, 'completo-webm', { assets, format: 'webm', width: 480, height: 270 }));
    check(await exportProject(p, 'completo-gif', { assets, format: 'gif', width: 320, height: 180, fps: 12 }));
    check(await exportProject(p, 'completo-audio', { assets, format: 'mp3' }));
  }
}

// ---------- Cada transición ----------
if (!quick) {
  console.log('Transiciones:');
  for (const tr of TRANSITIONS) {
    const p = baseProject();
    const V1 = p.tracks[0];
    const a = createClip('video', { trackId: V1.id, mediaId: 'm1', start: 0, duration: 2 });
    const b = createClip('video', { trackId: V1.id, mediaId: 'm2', start: 1.4, duration: 2, transitionIn: { type: tr.id, duration: 0.6 } });
    p.clips = [a, b];
    check(await exportProject(p, `tr-${tr.id}`, { width: 320, height: 180 }));
  }
}

// ---------- Rutas con caracteres especiales y MPEG-TS con inicio desplazado ----------
{
  console.log('Rutas especiales:');
  const weird = path.join(dir, "carpeta rara [1], it's á;b");
  fs.mkdirSync(weird, { recursive: true });
  const wv = path.join(weird, 'vídeo, (1).mp4');
  const wi = path.join(weird, "imagen 'x'.png");
  if (!fs.existsSync(wv)) fs.copyFileSync(files.v1, wv);
  if (!fs.existsSync(wi)) fs.copyFileSync(files.img, wi);
  const ts = await gen('v3.ts', ['-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=25:d=6', '-f', 'lavfi', '-i', 'sine=f=300:d=6', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-f', 'mpegts']);
  const p = baseProject();
  p.media = [...media, await mediaEntry('mw', wv, 'video'), await mediaEntry('mwi', wi, 'image'), await mediaEntry('mts', ts, 'video')];
  console.log(`  (inicio del .ts: ${p.media.find((m) => m.id === 'mts').start.toFixed(3)} s)`);
  const V1 = p.tracks[0];
  const V2 = createTrack('video');
  p.tracks.unshift(V2);
  p.clips = [
    createClip('video', { trackId: V1.id, mediaId: 'mw', start: 0, duration: 2, in: 1 }),
    createClip('video', { trackId: V1.id, mediaId: 'mts', start: 2, duration: 2, in: 1.5 }),
    createClip('image', { trackId: V2.id, mediaId: 'mwi', start: 0.5, duration: 2 }),
  ];
  p.clips[2].transform.scale = 0.3;
  check(await exportProject(p, 'rutas-input', { width: 320, height: 180 }));
  check(await exportProject(p, 'rutas-movie', { width: 320, height: 180, movie: true }));
}

// ---------- Casos límite ----------
{
  console.log('Casos límite:');
  const p = baseProject();
  check(await exportProject(p, 'vacio-con-audio', { width: 320, height: 180 }));
  const p2 = baseProject();
  const A1 = p2.tracks[1];
  p2.clips = [createClip('audio', { trackId: A1.id, mediaId: 'ma', start: 2, duration: 3 })];
  check(await exportProject(p2, 'solo-audio', { width: 320, height: 180 }));
  const p3 = baseProject();
  p3.settings.width = 1080;
  p3.settings.height = 1920;
  const V1 = p3.tracks[0];
  p3.clips = [createClip('video', { trackId: V1.id, mediaId: 'm1', start: 0, duration: 3 }), createClip('image', { trackId: V1.id, mediaId: 'mi', start: 3, duration: 1 })];
  check(await exportProject(p3, 'vertical', { width: 360, height: 640 }));
  // Fondo desenfocado (video, imagen fija e imagen con Ken Burns) y con transición.
  p3.clips = [
    createClip('video', { trackId: V1.id, mediaId: 'm1', start: 0, duration: 3, bgFill: 'blur' }),
    createClip('image', { trackId: V1.id, mediaId: 'mi', start: 2.5, duration: 2, bgFill: 'blur', transitionIn: { type: 'fade', duration: 0.5 } }),
    createClip('image', { trackId: V1.id, mediaId: 'mi', start: 4.5, duration: 1.5, bgFill: 'blur', kenburns: 'zoom-in' }),
  ];
  check(await exportProject(p3, 'vertical-desenfoque', { width: 360, height: 640 }));
}

// ---------- Fotogramas clave y miniaturas ----------
{
  console.log('Miniaturas:');
  // Un fotograma clave por segundo exacto: la lista debe encontrarlos sin decodificar el video.
  const kf = await gen('kf.mp4', ['-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=6', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '30', '-keyint_min', '30', '-sc_threshold', '0', '-pix_fmt', 'yuv420p']);
  const keys = await listKeyframes(kf);
  const okKeys = keys.length === 6 && keys.every((t, i) => Math.abs(t - i) < 0.05);
  console.log(`  ${okKeys ? '✓' : '✗'} fotogramas clave: ${keys.map((t) => t.toFixed(2)).join(' ')}`);
  check(okKeys);
  // Los dos métodos (saltar a fotogramas clave al decodificar, o buscar cada uno: AV1) dan miniaturas en orden.
  for (const seek of [false, true]) {
    const list = await extractThumbs(kf, path.join(dir, `miniaturas-${seek ? 'busqueda' : 'clave'}`), { duration: 6, count: 6, height: 36, seek });
    const ok = list.length >= 5 && list.every((t, i) => fs.existsSync(t.file) && (i === 0 || t.t > list[i - 1].t));
    console.log(`  ${ok ? '✓' : '✗'} miniaturas ${seek ? 'buscando cada fotograma clave' : 'decodificando solo los clave'}: ${list.length} (${list.map((t) => t.t.toFixed(1)).join(' ')})`);
    check(ok);
  }
  // MPEG-TS empieza en ~1,4 s: los instantes deben contarse desde el inicio del archivo (como en el visor).
  const ts = await gen('v3.ts', ['-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=25:d=6', '-f', 'lavfi', '-i', 'sine=f=300:d=6', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-f', 'mpegts']);
  const tsKeys = await listKeyframes(ts);
  const tsList = await extractThumbs(ts, path.join(dir, 'miniaturas-ts'), { duration: 6, count: 4, height: 36, seek: true });
  const okTs = tsKeys.length > 0 && Math.abs(tsKeys[0]) < 0.1 && tsList.length > 0 && tsList[0].t < 0.1;
  console.log(`  ${okTs ? '✓' : '✗'} MPEG-TS: primer fotograma clave en ${tsKeys[0]?.toFixed(2)} s, ${tsList.length} miniaturas`);
  check(okTs);
}

// ---------- Efectos, invertir, volumen y ritmo ----------
{
  console.log('Efectos y herramientas:');
  const p = baseProject();
  const V1 = p.tracks[0];
  const V2 = createTrack('video');
  p.tracks.unshift(V2);
  const c1 = createClip('video', { trackId: V1.id, mediaId: 'm1', start: 0, duration: 3, effects: [{ type: 'shake', intensity: 0.6 }, { type: 'flash', intensity: 0.8 }] });
  const c2 = createClip('image', { trackId: V1.id, mediaId: 'mi', start: 3, duration: 2, effects: [{ type: 'zoom-hit', intensity: 1 }, { type: 'zoom-pulse', intensity: 0.7, period: 0.5, phase: 0 }] });
  const c3 = createClip('image', { trackId: V2.id, mediaId: 'mi', start: 1, duration: 2, effects: [{ type: 'impact', intensity: 0.8 }, { type: 'flash', intensity: 0.5 }] });
  c3.transform.scale = 0.4;
  p.clips = [c1, c2, c3];
  check(await exportProject(p, 'efectos', { width: 640, height: 360 }));
  check(await exportProject(p, 'efectos-movie', { width: 640, height: 360, movie: true }));

  // Invertir: dura lo mismo y su primer fotograma es el último del tramo original.
  const rev = path.join(dir, 'invertido.mp4');
  fs.rmSync(rev, { force: true });
  await reverseRange(files.v1, rev, { start: 1, duration: 2, width: 1280, height: 720, fps: 30 });
  const ri = await probe(rev);
  const frames = await countFrames(rev);
  const ssimVs = async (t) => {
    let line = '';
    await runFfmpeg(['-hide_banner', '-nostdin', '-i', rev, '-ss', String(t), '-i', files.v1, '-filter_complex', '[0:v]trim=end_frame=1[a];[1:v]trim=end_frame=1[b];[a][b]ssim', '-f', 'null', '-'], {
      onLine: (l) => (/All:/.test(l) ? (line = l) : null),
    });
    return parseFloat(/All:([\d.]+)/.exec(line)?.[1] || '0');
  };
  const sEnd = await ssimVs(3 - 1 / 30);
  const sStart = await ssimVs(1);
  const okRev = Math.abs(ri.duration - 2) < 0.1 && Math.abs(frames - 60) <= 2 && ri.hasAudio && sEnd > 0.95 && sEnd > sStart + 0.02;
  console.log(`  ${okRev ? '✓' : '✗'} invertir: ${ri.duration.toFixed(2)} s, ${frames} fotogramas; 1.º invertido ≈ último original (SSIM ${sEnd.toFixed(3)} frente a ${sStart.toFixed(3)})`);
  check(okRev);

  // Volumen: el seno de prueba tiene una sonoridad medible.
  const loud = await measureLoudness(files.music, { start: 1, duration: 4 });
  const okLoud = Number.isFinite(loud.lufs) && loud.lufs < 0 && loud.lufs > -40 && loud.peak <= 0.5;
  console.log(`  ${okLoud ? '✓' : '✗'} volumen: ${loud.lufs.toFixed(1)} LUFS, pico ${loud.peak.toFixed(1)} dBFS`);
  check(okLoud);

  // Ritmo desde un archivo: golpes cada 0,5 s (120 BPM).
  const clicks = await gen('clics120.wav', ['-f', 'lavfi', '-i', "aevalsrc='0.8*sin(2*PI*900*t)*exp(-40*mod(t\\,0.5))':s=44100:d=12"]);
  const pcm = await extractPcm(clicks, { start: 2, duration: 8, rate: 8000 });
  const beats = analyzeBeats(pcm, 8000);
  const okBeats = Math.abs(beats.bpm - 120) < 2 && beats.beats.length >= 14 && beats.beats.every((b) => Math.abs(((b + 2) % 0.5) - 0) < 0.03 || Math.abs(((b + 2) % 0.5) - 0.5) < 0.03);
  console.log(`  ${okBeats ? '✓' : '✗'} ritmo desde archivo: ${beats.bpm} BPM, ${beats.beats.length} pulsos (${beats.beats.slice(0, 4).map((b) => (b + 2).toFixed(2)).join(' ')}…)`);
  check(okBeats);
}

console.log(failures ? `\n${failures} prueba(s) fallaron` : '\nTodas las pruebas pasaron');
process.exit(failures ? 1 : 0);
