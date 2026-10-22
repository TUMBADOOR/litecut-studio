// Utilidades de FFmpeg para el proceso principal (sin dependencias de Electron para poder probarlas con Node).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// Las tareas de fondo (miniaturas, ondas, copias ligeras) ceden la CPU a la vista previa y al resto del equipo.
export const BACKGROUND_PRIORITY = os.constants.priority.PRIORITY_BELOW_NORMAL;

function resolveFfmpeg() {
  if (process.env.LITECUT_FFMPEG) return process.env.LITECUT_FFMPEG;
  let p = null;
  try {
    p = require('ffmpeg-static');
  } catch {
    p = null;
  }
  if (!p) return 'ffmpeg';
  // Dentro del paquete (asar) el binario está desempaquetado.
  return p.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
}

export const ffmpegPath = resolveFfmpeg();

/**
 * Ejecuta FFmpeg. Resuelve siempre (no rechaza) con { code, stderr, killed }.
 * onStdout recibe trozos (Buffer) de la salida estándar; onLine recibe líneas de stderr.
 * priority (opcional): prioridad del proceso, p. ej. BACKGROUND_PRIORITY.
 */
export function runFfmpeg(args, { onStdout, onLine, signal, maxStderr = 200000, priority } = {}) {
  return new Promise((resolve) => {
    let stderr = '';
    let killed = false;
    let proc;
    try {
      proc = spawn(ffmpegPath, args, { windowsHide: true });
    } catch (err) {
      resolve({ code: -1, stderr: String(err), killed: false });
      return;
    }
    if (priority !== undefined && proc.pid) {
      try {
        os.setPriority(proc.pid, priority);
      } catch {
        /* sin permiso: se queda con la prioridad normal */
      }
    }
    const kill = () => {
      killed = true;
      try {
        proc.kill('SIGKILL');
      } catch {
        /* ya terminó */
      }
    };
    if (signal) {
      if (signal.aborted) kill();
      else signal.addEventListener('abort', kill, { once: true });
    }
    let partial = '';
    proc.stderr.on('data', (d) => {
      const s = d.toString();
      stderr += s;
      if (stderr.length > maxStderr) stderr = stderr.slice(-maxStderr);
      if (onLine) {
        partial += s;
        const lines = partial.split(/\r?\n|\r/);
        partial = lines.pop();
        for (const l of lines) onLine(l);
      }
    });
    proc.stdout.on('data', (d) => onStdout && onStdout(d));
    proc.on('error', (err) => {
      stderr += `\n${err.message}`;
    });
    proc.on('close', (code) => {
      if (signal) signal.removeEventListener('abort', kill);
      resolve({ code: code ?? -1, stderr, killed });
    });
  });
}

export function lastLines(text, n = 12) {
  return String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^\s*(frame|size|time|bitrate|speed|progress)=/.test(l))
    .slice(-n)
    .join('\n');
}

export async function ffmpegVersion() {
  let out = '';
  await runFfmpeg(['-hide_banner', '-version'], { onStdout: (d) => (out += d) });
  const m = /ffmpeg version n?(\d+)\.(\d+)/.exec(out);
  const text = out.split('\n')[0] || '';
  return m ? { major: +m[1], minor: +m[2], text } : { major: 0, minor: 0, text };
}

// FFmpeg 7+ lee el grafo con "-/filter_complex archivo"; versiones anteriores usan -filter_complex_script.
export function filterScriptArgs(version, scriptPath) {
  return version.major >= 7 ? ['-/filter_complex', scriptPath] : ['-filter_complex_script', scriptPath];
}

// ---------- Análisis de archivos ----------

export function parseProbe(text) {
  const info = {
    duration: 0,
    start: 0,
    hasVideo: false,
    hasAudio: false,
    width: 0,
    height: 0,
    fps: 0,
    vcodec: '',
    acodec: '',
    pixfmt: '',
    rotation: 0,
    container: '',
  };
  const dm = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text);
  if (dm) info.duration = +dm[1] * 3600 + +dm[2] * 60 + +dm[3];
  const sm = /Duration:.*?start:\s*(-?\d+(?:\.\d+)?)/.exec(text);
  if (sm) info.start = +sm[1];
  const cm = /Input #0,\s*([^,]+)/.exec(text);
  if (cm) info.container = cm[1];
  let sar = 1;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = /Stream #\d+:\d+.*?:\s*(Video|Audio):\s*(.*)$/.exec(line);
    if (!m) continue;
    if (m[1] === 'Video' && !info.hasVideo && !/attached pic/.test(line)) {
      info.hasVideo = true;
      info.vcodec = m[2].split(/[\s,(]/)[0];
      const pf = /^[^,]+,\s*([a-z0-9_]+)/i.exec(m[2]);
      if (pf) info.pixfmt = pf[1];
      const size = /(?:^|[\s,])(\d{2,5})x(\d{2,5})(?=[\s,\]]|$)/.exec(m[2]);
      if (size) {
        info.width = +size[1];
        info.height = +size[2];
      }
      const sarM = /SAR (\d+):(\d+)/.exec(m[2]);
      if (sarM && +sarM[1] > 0 && +sarM[2] > 0) sar = +sarM[1] / +sarM[2];
      const fpsM = /([\d.]+)\s*fps/.exec(m[2]) || /([\d.]+)\s*tbr/.exec(m[2]);
      if (fpsM) info.fps = parseFloat(fpsM[1]);
      // La rotación aparece en las líneas siguientes (side data / metadata)
      for (let j = i + 1; j < Math.min(lines.length, i + 12); j++) {
        if (/Stream #/.test(lines[j])) break;
        const r1 = /rotation of (-?[\d.]+) degrees/.exec(lines[j]);
        const r2 = /^\s*rotate\s*:\s*(-?\d+)/.exec(lines[j]);
        if (r1) info.rotation = Math.round(parseFloat(r1[1]));
        else if (r2) info.rotation = -parseInt(r2[1], 10);
      }
    } else if (m[1] === 'Audio' && !info.hasAudio) {
      info.hasAudio = true;
      info.acodec = m[2].split(/[\s,(]/)[0];
    }
  }
  if (Math.abs(sar - 1) > 0.01 && info.width) info.width = Math.round(info.width * sar);
  const rot = ((info.rotation % 360) + 360) % 360;
  if (rot === 90 || rot === 270) [info.width, info.height] = [info.height, info.width];
  return info;
}

export async function probe(file) {
  const { stderr } = await runFfmpeg(['-hide_banner', '-i', file]);
  const info = parseProbe(stderr);
  if (!info.hasVideo && !info.hasAudio) {
    const reason = /No such file/.test(stderr)
      ? 'El archivo no existe'
      : /Invalid data|could not find codec|Unknown format/i.test(stderr)
        ? 'Formato no compatible o archivo dañado'
        : 'No se encontraron pistas de audio ni video';
    const err = new Error(reason);
    err.details = lastLines(stderr, 6);
    throw err;
  }
  return info;
}

// ---------- Miniaturas (solo fotogramas clave: muy rápido) ----------

// Instantes de los fotogramas clave del primer video, en segundos desde el inicio del archivo (FFmpeg ya
// descuenta el desfase inicial del contenedor, igual que el visor). Solo lee paquetes, sin decodificar.
export async function listKeyframes(file, { signal } = {}) {
  const keys = [];
  let tb = 0.001;
  let partial = '';
  const parse = (line) => {
    if (line.startsWith('#tb 0:')) {
      const [n, d] = line.slice(6).trim().split('/').map(Number);
      if (n > 0 && d > 0) tb = n / d;
      return;
    }
    if (!line || line[0] === '#') return;
    const flags = /F=0x([0-9a-f]+)/i.exec(line);
    if (flags && !(parseInt(flags[1], 16) & 1)) return;
    const pts = Number(line.split(',')[2]);
    if (Number.isFinite(pts)) keys.push(pts * tb);
  };
  await runFfmpeg(['-hide_banner', '-nostdin', '-i', file, '-map', '0:v:0', '-c', 'copy', '-f', 'framecrc', '-'], {
    signal,
    priority: BACKGROUND_PRIORITY,
    onStdout: (d) => {
      partial += d.toString();
      const lines = partial.split('\n');
      partial = lines.pop();
      for (const l of lines) parse(l.trim());
    },
  });
  parse(partial.trim());
  return keys.sort((a, b) => a - b);
}

// Para códecs cuyo decodificador no sabe saltarse los fotogramas intermedios (AV1): se busca cada
// fotograma clave y se decodifica solo ese, en vez de decodificar el video entero.
async function thumbsBySeeking(file, outDir, { count, height, signal }) {
  const keys = await listKeyframes(file, { signal });
  if (!keys.length) keys.push(0);
  const step = Math.max(1, keys.length / count);
  const list = [];
  for (let i = 0; i < keys.length && list.length < count; i += step) {
    if (signal?.aborted) break;
    const t = Math.max(0, keys[Math.floor(i)]);
    const out = path.join(outDir, `t_${String(list.length + 1).padStart(4, '0')}.jpg`);
    const args = ['-hide_banner', '-nostdin', '-y', '-ss', (t + 0.001).toFixed(3), '-noaccurate_seek', '-i', file];
    args.push('-an', '-sn', '-frames:v', '1', '-vf', `scale=-2:${height}`, '-q:v', '7', out);
    const r = await runFfmpeg(args, { signal, priority: BACKGROUND_PRIORITY });
    if (r.code === 0 && fs.existsSync(out)) list.push({ t, file: out });
  }
  return list;
}

export async function extractThumbs(file, outDir, { duration = 0, count = 40, height = 72, start = 0, signal, seek = false } = {}) {
  fs.mkdirSync(outDir, { recursive: true });
  for (const f of fs.readdirSync(outDir)) if (f.endsWith('.jpg')) fs.rmSync(path.join(outDir, f), { force: true });
  if (seek) return thumbsBySeeking(file, outDir, { count, height, signal });
  const interval = Math.max(0.5, (duration || 10) / count);
  const run = async (keyOnly) => {
    const times = [];
    const vf = keyOnly
      ? `select=isnan(prev_selected_t)+gte(t-prev_selected_t\\,${interval.toFixed(3)}),scale=-2:${height},showinfo`
      : `fps=1/${interval.toFixed(3)},scale=-2:${height},showinfo`;
    const args = ['-hide_banner', '-nostdin'];
    if (keyOnly) args.push('-skip_frame', 'nokey');
    args.push('-i', file, '-an', '-sn', '-vf', vf, '-fps_mode', 'vfr', '-q:v', '7', '-frames:v', String(count * 2 + 10), path.join(outDir, 't_%04d.jpg'));
    await runFfmpeg(args, {
      signal,
      priority: BACKGROUND_PRIORITY,
      onLine: (l) => {
        const m = /Parsed_showinfo.*?pts_time:\s*(-?[\d.]+)/.exec(l);
        if (m) times.push(Math.max(0, parseFloat(m[1]) - start));
      },
    });
    const files = fs
      .readdirSync(outDir)
      .filter((f) => /^t_\d+\.jpg$/.test(f))
      .sort();
    return files.map((f, i) => ({ t: times[i] ?? i * interval, file: path.join(outDir, f) }));
  };
  let list = await run(true);
  if (list.length < 2 && duration > 2 * interval) list = await run(false);
  return list;
}

// ---------- Forma de onda (picos de audio) ----------

export function extractPeaks(file, { perSec = 50, rate = 8000, signal } = {}) {
  const bucket = Math.round(rate / perSec);
  const peaks = [];
  let cur = 0;
  let count = 0;
  let leftover = null;
  return runFfmpeg(['-hide_banner', '-nostdin', '-i', file, '-vn', '-sn', '-ac', '1', '-ar', String(rate), '-f', 's16le', '-acodec', 'pcm_s16le', 'pipe:1'], {
    signal,
    priority: BACKGROUND_PRIORITY,
    onStdout: (chunk) => {
      let buf = chunk;
      if (leftover) {
        buf = Buffer.concat([leftover, chunk]);
        leftover = null;
      }
      const n = buf.length >> 1;
      if (buf.length & 1) leftover = buf.subarray(buf.length - 1);
      for (let i = 0; i < n; i++) {
        const v = Math.abs(buf.readInt16LE(i * 2));
        if (v > cur) cur = v;
        if (++count >= bucket) {
          peaks.push(Math.min(255, Math.round((cur / 32768) * 255)));
          cur = 0;
          count = 0;
        }
      }
    },
  }).then(({ code }) => {
    if (count > 0) peaks.push(Math.min(255, Math.round((cur / 32768) * 255)));
    return { ok: code === 0 || peaks.length > 0, perSec, data: Uint8Array.from(peaks) };
  });
}

// ---------- Progreso (-progress pipe:1) ----------

export function progressParser(total, onProgress) {
  let buf = '';
  let last = {};
  return (chunk) => {
    buf += chunk.toString();
    const lines = buf.split(/\r?\n/);
    buf = lines.pop();
    for (const l of lines) {
      const i = l.indexOf('=');
      if (i < 0) continue;
      const k = l.slice(0, i).trim();
      const v = l.slice(i + 1).trim();
      last[k] = v;
      if (k === 'progress') {
        const us = parseInt(last.out_time_us || last.out_time_ms || '0', 10);
        const t = isFinite(us) ? us / 1e6 : 0;
        const speed = parseFloat(String(last.speed || '').replace('x', '')) || 0;
        onProgress({ time: t, percent: total > 0 ? Math.max(0, Math.min(1, t / total)) : 0, speed, done: v === 'end' });
        last = {};
      }
    }
  };
}

// ---------- Proxy de edición (formatos que el visor no reproduce o videos demasiado pesados para el equipo) ----------
// 720p H.264 (la gráfica lo decodifica casi en cualquier equipo) con un fotograma clave cada 30: saltar es inmediato.

export async function makeProxy(file, outPath, { kind = 'video', duration = 0, hasAudio = true, onProgress, signal } = {}) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const tmp = `${outPath}.part${path.extname(outPath)}`;
  let args;
  if (kind === 'audio') {
    args = ['-hide_banner', '-y', '-nostdin', '-i', file, '-vn', '-c:a', 'aac', '-b:a', '160k'];
  } else if (kind === 'image') {
    args = ['-hide_banner', '-y', '-nostdin', '-i', file, '-frames:v', '1'];
  } else {
    args = ['-hide_banner', '-y', '-nostdin', '-i', file, '-map', '0:v:0'];
    if (hasAudio) args.push('-map', '0:a:0?');
    args.push(
      '-vf',
      'scale=-2:min(720\\,ih),format=yuv420p',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-crf',
      '26',
      '-g',
      '30',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-movflags',
      '+faststart'
    );
  }
  args.push('-progress', 'pipe:1', '-nostats', tmp);
  const res = await runFfmpeg(args, { signal, priority: BACKGROUND_PRIORITY, onStdout: progressParser(duration, (p) => onProgress && onProgress(p.percent)) });
  if (res.code !== 0 || !fs.existsSync(tmp)) {
    fs.rmSync(tmp, { force: true });
    const err = new Error(res.killed ? 'Cancelado' : 'No se pudo convertir el archivo');
    err.details = lastLines(res.stderr);
    throw err;
  }
  fs.renameSync(tmp, outPath);
  return outPath;
}

// Fotograma exacto en resolución completa (congelar imagen).
export async function extractFrame(file, time, outPath) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const t = String(Math.max(0, time));
  let res = await runFfmpeg(['-hide_banner', '-y', '-nostdin', '-ss', t, '-i', file, '-frames:v', '1', '-update', '1', outPath]);
  if (res.code !== 0 || !fs.existsSync(outPath)) {
    // Archivos sin índice (p. ej. MPEG-TS): decodificar desde el inicio hasta el instante pedido.
    res = await runFfmpeg(['-hide_banner', '-y', '-nostdin', '-i', file, '-ss', t, '-frames:v', '1', '-update', '1', outPath]);
  }
  if (res.code !== 0 || !fs.existsSync(outPath)) {
    const err = new Error('No se pudo extraer el fotograma');
    err.details = lastLines(res.stderr);
    throw err;
  }
  return outPath;
}

// ---------- Análisis para asistentes de IA ----------
// Livianos para equipos modestos: prioridad baja, solo la pista necesaria, video reducido antes de analizarlo
// y un tiempo máximo (maxSeconds) tras el cual se devuelve lo analizado hasta ese momento.

function limitedSignal(signal, maxSeconds) {
  const ac = new AbortController();
  const state = { signal: ac.signal, timedOut: false };
  const onAbort = () => ac.abort();
  if (signal) {
    if (signal.aborted) ac.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = maxSeconds > 0 ? setTimeout(() => ((state.timedOut = true), ac.abort()), maxSeconds * 1000) : null;
  state.done = () => {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  };
  return state;
}

function analysisError(res, message) {
  const err = new Error(res.killed ? 'Análisis cancelado' : message);
  err.details = lastLines(res.stderr, 6);
  return err;
}

// Pausas del sonido en segundos del archivo: { silences: [{ start, end }], complete, analyzed }.
export async function detectSilences(file, { noise = -35, minDuration = 0.5, duration = 0, maxSeconds = 0, signal, onProgress } = {}) {
  const lim = limitedSignal(signal, maxSeconds);
  const silences = [];
  let open = null;
  let reached = 0;
  const args = ['-hide_banner', '-nostdin', '-i', file, '-map', '0:a:0', '-vn', '-sn', '-dn'];
  args.push('-af', `silencedetect=noise=${noise}dB:d=${minDuration}`, '-f', 'null', '-progress', 'pipe:1', '-nostats', '-');
  const res = await runFfmpeg(args, {
    signal: lim.signal,
    priority: BACKGROUND_PRIORITY,
    onLine: (l) => {
      const s = /silence_start:\s*(-?[\d.]+)/.exec(l);
      if (s) open = Math.max(0, parseFloat(s[1]));
      const e = /silence_end:\s*(-?[\d.]+)/.exec(l);
      if (e) {
        silences.push({ start: open ?? 0, end: parseFloat(e[1]) });
        open = null;
      }
    },
    onStdout: progressParser(duration, (p) => {
      reached = p.time;
      onProgress?.(p.percent);
    }),
  });
  lim.done();
  if (!lim.timedOut && (res.killed || res.code !== 0)) throw analysisError(res, 'No se pudo analizar el sonido (¿el archivo tiene audio?)');
  const end = lim.timedOut ? reached : duration || reached;
  if (open !== null && end > open) silences.push({ start: open, end }); // termina en silencio
  return { silences: silences.filter((s) => s.end > s.start), complete: !lim.timedOut, analyzed: end };
}

// Cambios de escena (filtro scdet) en segundos del archivo: { scenes: [{ time, score }], complete, analyzedUntil }.
export async function detectScenes(file, { threshold = 12, start = 0, duration = 0, width = 192, maxSeconds = 0, signal, onProgress } = {}) {
  const lim = limitedSignal(signal, maxSeconds);
  const scenes = [];
  let reached = 0;
  const args = ['-hide_banner', '-nostdin'];
  if (start > 0) args.push('-ss', start.toFixed(3));
  if (duration > 0) args.push('-t', duration.toFixed(3));
  args.push('-i', file, '-map', '0:v:0', '-an', '-sn', '-dn');
  args.push('-vf', `scale=${width}:-2:flags=fast_bilinear,scdet=threshold=${threshold}`, '-f', 'null', '-progress', 'pipe:1', '-nostats', '-');
  const res = await runFfmpeg(args, {
    signal: lim.signal,
    priority: BACKGROUND_PRIORITY,
    onLine: (l) => {
      const m = /lavfi\.scd\.score:\s*([\d.]+),\s*lavfi\.scd\.time:\s*(-?[\d.]+)/.exec(l);
      if (m) scenes.push({ time: start + parseFloat(m[2]), score: parseFloat(m[1]) });
    },
    onStdout: progressParser(duration, (p) => {
      reached = p.time;
      onProgress?.(p.percent);
    }),
  });
  lim.done();
  if (!lim.timedOut && (res.killed || res.code !== 0)) throw analysisError(res, 'No se pudo analizar el video');
  return { scenes, complete: !lim.timedOut, analyzedUntil: start + (lim.timedOut ? reached : duration || reached) };
}

const imageCodecArgs = (format) => (format === 'png' ? ['-c:v', 'png'] : ['-c:v', 'mjpeg', '-q:v', '4']);

// Varias imágenes pequeñas repartidas en [start, end) con una sola pasada de FFmpeg: decodifica el tramo
// (rápido en tramos cortos) o, con keyframesOnly, solo los fotogramas clave (rápido en videos largos).
// Devuelve [{ time, file }] con el instante real de cada imagen en segundos del archivo.
export async function sampleFrames(file, outDir, { start = 0, end, count = 6, width = 320, format = 'jpeg', keyframesOnly = false, signal } = {}) {
  fs.mkdirSync(outDir, { recursive: true });
  const ext = format === 'png' ? 'png' : 'jpg';
  const span = Math.max(0.1, end - start);
  const interval = span / count;
  const select = keyframesOnly
    ? `select=isnan(prev_selected_t)+gte(t-prev_selected_t\\,${interval.toFixed(3)})`
    : `select=isnan(prev_selected_t)*gte(t\\,${(interval / 2).toFixed(3)})+gte(t-prev_selected_t\\,${interval.toFixed(3)})`;
  const times = [];
  const args = ['-hide_banner', '-nostdin', '-y'];
  if (keyframesOnly) args.push('-skip_frame', 'nokey');
  if (start > 0) args.push('-ss', start.toFixed(3));
  args.push('-t', span.toFixed(3), '-i', file, '-map', '0:v:0', '-an', '-sn', '-dn');
  args.push('-vf', `${select},scale=${width}:-2:flags=bicubic,showinfo`, '-fps_mode', 'vfr', '-frames:v', String(count));
  args.push(...imageCodecArgs(format), path.join(outDir, `m_%02d.${ext}`));
  const res = await runFfmpeg(args, {
    signal,
    priority: BACKGROUND_PRIORITY,
    onLine: (l) => {
      const m = /Parsed_showinfo.*?pts_time:\s*(-?[\d.]+)/.exec(l);
      if (m) times.push(start + Math.max(0, parseFloat(m[1])));
    },
  });
  if (res.killed) throw analysisError(res, '');
  return fs
    .readdirSync(outDir)
    .filter((f) => f.startsWith('m_') && f.endsWith(`.${ext}`))
    .sort()
    .map((f, i) => ({ time: times[i] ?? start + interval * (i + 0.5), file: path.join(outDir, f) }));
}

// Un fotograma pequeño en el instante t (segundos del archivo), como Buffer de imagen.
export async function grabFrame(file, t, { width = 320, format = 'jpeg', signal } = {}) {
  const run = async (inputSeek) => {
    const chunks = [];
    const ss = ['-ss', Math.max(0, t).toFixed(3)];
    const args = ['-hide_banner', '-nostdin', ...(inputSeek ? ss : []), '-i', file, ...(inputSeek ? [] : ss), '-map', '0:v:0', '-an', '-sn', '-dn'];
    args.push('-frames:v', '1', '-vf', `scale=${width}:-2:flags=bicubic`, ...imageCodecArgs(format), '-f', 'image2pipe', 'pipe:1');
    const res = await runFfmpeg(args, { signal, priority: BACKGROUND_PRIORITY, onStdout: (d) => chunks.push(d) });
    if (res.killed) throw analysisError(res, '');
    return Buffer.concat(chunks);
  };
  let buf = await run(true);
  if (!buf.length) buf = await run(false); // archivos sin índice: decodificar desde el principio
  if (!buf.length) throw new Error('No se pudo extraer el fotograma');
  return buf;
}

// ---------- Codificadores por hardware ----------

const HW_CANDIDATES = {
  win32: { h264: ['h264_nvenc', 'h264_qsv', 'h264_amf', 'h264_mf'], hevc: ['hevc_nvenc', 'hevc_qsv', 'hevc_amf', 'hevc_mf'] },
  darwin: { h264: ['h264_videotoolbox'], hevc: ['hevc_videotoolbox'] },
  linux: { h264: ['h264_nvenc', 'h264_vaapi'], hevc: ['hevc_nvenc'] },
};

function hwTestArgs(enc) {
  const extra = enc.endsWith('_mf') ? ['-hw_encoding', '1'] : [];
  return ['-hide_banner', '-nostdin', '-f', 'lavfi', '-i', 'color=c=black:s=640x360:r=30:d=0.3', '-frames:v', '6', '-pix_fmt', 'yuv420p', '-c:v', enc, ...extra, '-b:v', '1M', '-f', 'null', '-'];
}

export async function detectHardwareEncoders() {
  const list = await new Promise((resolve) => {
    let out = '';
    const p = spawn(ffmpegPath, ['-hide_banner', '-encoders'], { windowsHide: true });
    p.stdout.on('data', (d) => (out += d));
    p.on('close', () => resolve(out));
    p.on('error', () => resolve(''));
  });
  const available = new Set();
  for (const line of list.split(/\r?\n/)) {
    const m = /^\s*[VAS.][F.][S.][X.][B.][D.]\s+(\S+)/.exec(line);
    if (m) available.add(m[1]);
  }
  const cands = HW_CANDIDATES[process.platform] || HW_CANDIDATES.linux;
  const result = { h264: null, hevc: null, software: { x264: available.has('libx264'), x265: available.has('libx265'), vp9: available.has('libvpx-vp9') } };
  for (const kind of ['h264', 'hevc']) {
    for (const enc of cands[kind]) {
      if (!available.has(enc)) continue;
      const { code } = await runFfmpeg(hwTestArgs(enc));
      if (code === 0) {
        result[kind] = enc;
        break;
      }
    }
  }
  return result;
}

const QUALITY = {
  high: { bpp: 0.11, crf264: 19, crf265: 23, crfvp9: 30, ab: '192k', mp3: '256k' },
  medium: { bpp: 0.07, crf264: 23, crf265: 27, crfvp9: 34, ab: '160k', mp3: '192k' },
  low: { bpp: 0.045, crf264: 27, crf265: 30, crfvp9: 38, ab: '128k', mp3: '128k' },
};

export function bitrateFor(width, height, fps, quality = 'medium') {
  const q = QUALITY[quality] || QUALITY.medium;
  return Math.max(300, Math.round((width * height * Math.max(fps, 24) * q.bpp) / 1000));
}

// Argumentos de codificación según formato y codificador elegido.
export function encoderArgs({ format, quality = 'medium', width, height, fps, hw }) {
  const q = QUALITY[quality] || QUALITY.medium;
  const kb = bitrateFor(width, height, fps, quality);
  const rate = [`-b:v`, `${kb}k`, '-maxrate', `${Math.round(kb * 1.5)}k`, '-bufsize', `${kb * 2}k`];
  const hwArgs = (enc) => {
    if (enc.endsWith('_nvenc')) return ['-c:v', enc, '-preset', 'p4', ...rate];
    if (enc.endsWith('_qsv')) return ['-c:v', enc, '-preset', 'faster', ...rate];
    if (enc.endsWith('_amf')) return ['-c:v', enc, '-quality', 'balanced', '-rc', 'vbr_peak', ...rate];
    if (enc.endsWith('_mf')) return ['-c:v', enc, '-hw_encoding', '1', ...rate];
    if (enc.endsWith('_videotoolbox')) return ['-c:v', enc, '-allow_sw', '1', ...rate];
    return ['-c:v', enc, ...rate];
  };
  switch (format) {
    case 'mp4':
      return {
        video: hw ? hwArgs(hw) : ['-c:v', 'libx264', '-preset', quality === 'high' ? 'fast' : 'veryfast', '-crf', String(q.crf264)],
        audio: ['-c:a', 'aac', '-b:a', q.ab],
        extra: ['-pix_fmt', 'yuv420p', '-movflags', '+faststart'],
        ext: 'mp4',
      };
    case 'mp4-hevc':
      return {
        video: hw ? [...hwArgs(hw), '-tag:v', 'hvc1'] : ['-c:v', 'libx265', '-preset', 'fast', '-crf', String(q.crf265), '-tag:v', 'hvc1'],
        audio: ['-c:a', 'aac', '-b:a', q.ab],
        extra: ['-pix_fmt', 'yuv420p', '-movflags', '+faststart'],
        ext: 'mp4',
      };
    case 'webm':
      return {
        video: ['-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-row-mt', '1', '-crf', String(q.crfvp9), '-b:v', `${kb}k`],
        audio: ['-c:a', 'libopus', '-b:a', '128k'],
        extra: ['-pix_fmt', 'yuv420p'],
        ext: 'webm',
      };
    case 'gif':
      return { video: ['-c:v', 'gif'], audio: [], extra: ['-loop', '0'], ext: 'gif' };
    case 'mp3':
      return { video: [], audio: ['-c:a', 'libmp3lame', '-b:a', q.mp3], extra: [], ext: 'mp3' };
    case 'wav':
      return { video: [], audio: ['-c:a', 'pcm_s16le'], extra: [], ext: 'wav' };
    default:
      throw new Error(`Formato desconocido: ${format}`);
  }
}

// ---------- Grabaciones ----------

// Convierte la grabación del navegador (WebM) en un archivo cómodo de editar y compartir.
export async function finalizeRecording(input, outBase, { videoCodec = '', hasAudio = true, crop = null, hw = null, duration = 0, onProgress, audioOnly = false } = {}) {
  let output;
  let args;
  if (audioOnly) {
    output = `${outBase}.m4a`;
    args = ['-hide_banner', '-y', '-nostdin', '-fflags', '+genpts', '-i', input, '-vn', '-c:a', 'aac', '-b:a', '160k', output];
  } else if (crop) {
    output = `${outBase}.mp4`;
    const vf = `crop=w=trunc(iw*${crop.w.toFixed(5)}/2)*2:h=trunc(ih*${crop.h.toFixed(5)}/2)*2:x=iw*${crop.x.toFixed(5)}:y=ih*${crop.y.toFixed(5)},format=yuv420p`;
    const v = hw
      ? encoderArgs({ format: 'mp4', quality: 'high', width: 1920, height: 1080, fps: 30, hw }).video
      : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21'];
    args = ['-hide_banner', '-y', '-nostdin', '-fflags', '+genpts', '-i', input, '-vf', vf, ...v];
    if (hasAudio) args.push('-c:a', 'aac', '-b:a', '160k');
    args.push('-movflags', '+faststart');
    args.push('-progress', 'pipe:1', '-nostats', output);
  } else if (/h264|avc/i.test(videoCodec)) {
    output = `${outBase}.mp4`;
    args = ['-hide_banner', '-y', '-nostdin', '-fflags', '+genpts', '-i', input, '-c:v', 'copy'];
    if (hasAudio) args.push('-c:a', 'aac', '-b:a', '160k');
    args.push('-movflags', '+faststart', output);
  } else {
    output = `${outBase}.webm`;
    args = ['-hide_banner', '-y', '-nostdin', '-fflags', '+genpts', '-i', input, '-c', 'copy', output];
  }
  const res = await runFfmpeg(args, { onStdout: onProgress ? progressParser(duration, (p) => onProgress(p.percent)) : undefined });
  if (res.code !== 0 || !fs.existsSync(output) || fs.statSync(output).size < 1000) {
    // Último recurso: recodificar por completo.
    output = `${outBase}.mp4`;
    const fallback = ['-hide_banner', '-y', '-nostdin', '-fflags', '+genpts', '-i', input];
    if (audioOnly) {
      output = `${outBase}.m4a`;
      fallback.push('-vn', '-c:a', 'aac', '-b:a', '160k', output);
    } else {
      if (crop) {
        fallback.push('-vf', `crop=w=trunc(iw*${crop.w.toFixed(5)}/2)*2:h=trunc(ih*${crop.h.toFixed(5)}/2)*2:x=iw*${crop.x.toFixed(5)}:y=ih*${crop.y.toFixed(5)}`);
      }
      fallback.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p');
      if (hasAudio) fallback.push('-c:a', 'aac', '-b:a', '160k');
      fallback.push('-movflags', '+faststart', output);
    }
    const r2 = await runFfmpeg(fallback);
    if (r2.code !== 0 || !fs.existsSync(output)) {
      const err = new Error('No se pudo procesar la grabación');
      err.details = lastLines(r2.stderr || res.stderr);
      throw err;
    }
  }
  return output;
}
