// Convierte un proyecto en un grafo de filtros de FFmpeg.
//
// Estrategia (pensada para equipos modestos):
//  - La pista principal (V1) se arma con "concat": cada clip se compone sobre el color de fondo
//    y FFmpeg solo decodifica el clip que está sonando en cada momento (bajo consumo de memoria).
//  - Las transiciones se generan como segmentos propios mezclando el final de A con el inicio de B.
//  - Las pistas superiores (textos, imágenes, picture-in-picture) se superponen con "overlay".
//  - El audio de cada clip se recorta, ajusta (velocidad, volumen, fundidos) y se mezcla con "amix".
import { videoTracks, mainTrack, trackClips, clipEnd, clipHasAudio, projectDuration, isVisual } from './model.js';
import {
  colorPipeline,
  ffColorFilters,
  ffVignetteAlphaExpr,
  ffMaskExpr,
  clipMotion,
  transitionFx,
  ffMotionExprs,
  ffFadeFilters,
  ffRevealExpr,
  motionIsStatic,
  BG_BLUR,
  bgBlurSigma,
  fmtNum as n5,
} from './effects.js';
import { cropRect, hasCrop, mainTrackItems } from './layout.js';

const even = (v) => Math.max(2, Math.round(v / 2) * 2);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// ¿Se puede buscar (-ss) con precisión en este archivo? Los contenedores sin índice (MPEG-TS, MPEG-PS,
// FLV, Ogg, GIF) pueden no encontrar fotogramas clave al buscar; con ellos se decodifica desde el
// principio y se recorta.
const UNSEEKABLE_CONTAINER = /mpegts|mpeg|flv|ogg|gif/i;
const UNSEEKABLE_EXT = /\.(ts|mts|m2ts|mpg|mpeg|vob|flv|ogv|ogg|oga|gif)$/i;
export function canSeek(m) {
  if (m.container) return !UNSEEKABLE_CONTAINER.test(m.container);
  return !UNSEEKABLE_EXT.test(m.path || '');
}

// Ruta de archivo dentro de un grafo de filtros: barras normales y escapado en dos niveles
// (valor de opción y descripción del grafo). Ej.: C:\a b\v.mp4 → C\\:/a b/v.mp4
export function ffFilterPath(p) {
  const lvl1 = String(p)
    .replace(/\\/g, '/')
    .replace(/[\\':]/g, (c) => `\\${c}`);
  return lvl1.replace(/[\\'[\],;]/g, (c) => `\\${c}`);
}

export function ffColor(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  return m ? `0x${m[1].toLowerCase()}` : 'black';
}

export function atempoChain(speed) {
  const out = [];
  let s = speed;
  while (s > 2 + 1e-9) {
    out.push('atempo=2');
    s /= 2;
  }
  while (s < 0.5 - 1e-9) {
    out.push('atempo=0.5');
    s /= 0.5;
  }
  if (Math.abs(s - 1) > 1e-6) out.push(`atempo=${n5(s)}`);
  return out;
}

// Elementos de la pista principal convertidos a cuadros, con transiciones saneadas.
export function mainTrackFrames(project, fps) {
  const F = (sec) => Math.round(sec * fps);
  const base = mainTrack(project);
  if (!base) return [];
  const items = mainTrackItems(project).map((it) => ({
    clip: it.clip,
    s: F(it.start),
    e: F(it.end),
    transition: it.transition,
    head: 0,
    tail: 0,
  }));
  for (let i = 1; i < items.length; i++) {
    const a = items[i - 1];
    const b = items[i];
    if (b.s < a.s + a.head) b.s = a.s + a.head; // nunca empezar dentro de la transición anterior
    if (b.e < b.s) b.e = b.s;
    if (a.e > b.s) {
      const ov = b.transition ? Math.min(a.e - b.s, a.e - a.s - a.head, b.e - b.s) : 0;
      if (ov > 0) {
        a.e = b.s + ov;
        a.tail = ov;
        b.head = ov;
      } else {
        b.transition = null;
        a.e = b.s;
      }
    } else {
      b.transition = null;
    }
  }
  return items.filter((it) => it.e > it.s);
}

/**
 * @param project proyecto normalizado
 * @param opts { width, height, fps, includeVideo, includeAudio, gif }
 * @param assets { text: { [clipId]: { path, w, h } } } PNG de los textos ya renderizados a la escala de salida
 */
export function buildExportGraph(project, opts, assets = {}) {
  const PW = project.settings.width;
  const PH = project.settings.height;
  const W = even(opts.width);
  const H = even(opts.height);
  const k = W / PW;
  const fps = opts.fps;
  const includeVideo = opts.includeVideo !== false;
  const includeAudio = opts.includeAudio !== false;
  const bg = ffColor(project.settings.background);
  const media = new Map(project.media.map((m) => [m.id, m]));
  const tracks = new Map(project.tracks.map((t) => [t.id, t]));
  const F = (sec) => Math.round(sec * fps);
  const frameDur = n5(1 / fps);

  const TF = Math.max(1, F(projectDuration(project)));
  const total = TF / fps;

  const inputs = [];
  const chains = [];
  const warnings = [];
  let counter = 0;
  const L = (p) => `${p}${counter++}`;
  const addInput = (args) => {
    inputs.push(args);
    return inputs.length - 1;
  };
  // Repite un cuadro; la base de tiempo se fija a 1/fps para que las marcas sean exactas
  // (las imágenes llegan con base 1/25 y N/fps/TB se redondearía, duplicando marcas).
  const loopTo = (nFrames) => (nFrames > 1 ? `,loop=loop=${nFrames - 1}:size=1:start=0,settb=1/${fps},setpts=N` : '');
  // Con muchísimos clips, las fuentes se abren dentro del grafo (filtro movie) para no superar
  // el límite de longitud de la línea de comandos de Windows.
  const useMovie = !!opts.movieSources;
  const movieSrc = (file, audio, inPoint = 0, dur = null, start = 0, seekable = true) => {
    const lbl = L(audio ? 'am' : 'mv');
    let chain = `${audio ? 'amovie' : 'movie'}=filename=${ffFilterPath(file)}`;
    if (inPoint > 0 && seekable) chain += `:sp=${n5(inPoint)}`;
    if (!audio) chain += ':dec_threads=2';
    if (dur !== null) {
      chain += audio
        ? `,atrim=start=${n5(inPoint + start)}:duration=${n5(dur)},asetpts=PTS-STARTPTS`
        : `,trim=start=${n5(inPoint + start)}:duration=${n5(dur)},setpts=PTS-STARTPTS`;
    }
    chains.push(`${chain}[${lbl}]`);
    return `[${lbl}]`;
  };

  // Fuente de un clip de video o imagen: etiqueta + filtros iniciales (tramo, velocidad, fps fijos).
  function mediaSource(clip, m, N) {
    const pre = [];
    if (clip.type === 'image') return { src: useMovie ? movieSrc(m.path, false) : `[${addInput(['-i', m.path])}:v]`, pre, still: true };
    const D = N / fps;
    const speed = clip.speed || 1;
    const inPoint = clamp(clip.in || 0, 0, Math.max(0, (m.duration || 0) - 0.05));
    const seekable = canSeek(m);
    let src;
    if (useMovie) src = movieSrc(m.path, false, inPoint, D * speed + 0.25, m.start || 0, seekable);
    else if (seekable) src = `[${addInput(['-threads', '2', '-ss', n5(inPoint), '-t', n5(D * speed + 0.25), '-i', m.path])}:v]`;
    else {
      // FFmpeg ya resta el tiempo de inicio del archivo en las entradas "-i".
      src = `[${addInput(['-threads', '2', '-i', m.path])}:v]`;
      pre.push(`trim=start=${n5(inPoint)}:duration=${n5(D * speed + 0.25)}`);
    }
    pre.push('setpts=PTS-STARTPTS');
    if (Math.abs(speed - 1) > 1e-6) pre.push(`setpts=PTS/${n5(speed)}`);
    pre.push(`fps=${fps}`, `tpad=stop_mode=clone:stop_duration=${n5(D + 1)}`, `trim=end_frame=${N}`);
    return { src, pre, still: false };
  }

  function cropFilter(clip, m, r) {
    if (!hasCrop(clip)) return null;
    const c = clip.crop;
    return `crop=w=iw*${n5(r.w / m.width)}:h=ih*${n5(r.h / m.height)}:x=iw*${n5(Math.max(0, c.l || 0))}:y=ih*${n5(Math.max(0, c.t || 0))}`;
  }

  // Fondo desenfocado: el mismo clip cubriendo el lienzo, desenfocado y oscurecido (a 1/4 de resolución).
  function blurBackground(clip, N, single) {
    const m = media.get(clip.mediaId);
    const ms = mediaSource(clip, m, N);
    const r = cropRect(clip, m);
    const f = [...ms.pre];
    const cf = cropFilter(clip, m, r);
    if (cf) f.push(cf);
    const q = 4;
    const cover = Math.max(W / r.w, H / r.h) * BG_BLUR.overscale;
    const d = n5(BG_BLUR.darken);
    f.push(
      `scale=${even((r.w * cover) / q)}:${even((r.h * cover) / q)}:flags=bilinear`,
      `crop=${even(W / q)}:${even(H / q)}`,
      `gblur=sigma=${n5((bgBlurSigma(PW, PH) * k) / q)}`,
      `colorchannelmixer=rr=${d}:gg=${d}:bb=${d}`,
      `scale=${W}:${H}:flags=bilinear`,
      'format=yuv420p',
      'setsar=1'
    );
    const lbl = L('bb');
    chains.push(`${ms.src}${f.join(',')}${ms.still && !single ? loopTo(N) : ''}[${lbl}]`);
    return lbl;
  }

  // ---------------- Capa de un clip ----------------
  // Devuelve { label, still, covers, pos(tv) } o null si falta el recurso.
  // still = un único cuadro (imagen/texto sin animación) que el llamador debe repetir.
  function layerChain(clip, N, motion, keepStill) {
    const f = [];
    let src;
    let still = false;
    let w;
    let h;
    let rgba = false;
    let isOpaqueVideo = false;
    let cp = null;
    if (clip.type === 'text') {
      const a = assets.text?.[clip.id];
      if (!a) {
        warnings.push(`Falta el texto renderizado del clip ${clip.id}`);
        return null;
      }
      src = useMovie ? movieSrc(a.path, false) : `[${addInput(['-i', a.path])}:v]`;
      still = true;
      f.push('format=rgba');
      rgba = true;
      w = a.w;
      h = a.h;
    } else {
      const m = media.get(clip.mediaId);
      if (!m || !m.path || !(m.width > 0) || !(m.height > 0)) {
        warnings.push(`Falta el archivo del clip ${clip.name || clip.id}`);
        return null;
      }
      const r = cropRect(clip, m);
      const fit = Math.min(PW / r.w, PH / r.h);
      const s = clip.transform.scale || 1;
      w = even(r.w * fit * s * k);
      h = even(r.h * fit * s * k);
      const ms = mediaSource(clip, m, N);
      src = ms.src;
      f.push(...ms.pre);
      still = ms.still;
      isOpaqueVideo = !ms.still;
      const cf = cropFilter(clip, m, r);
      if (cf) f.push(cf);
      f.push(`scale=${w}:${h}:flags=bicubic`, 'setsar=1');
      if (clip.transform.flipH) f.push('hflip');
      if (clip.transform.flipV) f.push('vflip');
      cp = colorPipeline(clip.adjust);
      const colorF = ffColorFilters(cp);
      if (clip.type === 'image' || colorF.length || cp.blur > 0.01) {
        f.push('format=rgba');
        rgba = true;
      }
      f.push(...colorF);
      if (cp.blur > 0.01) f.push(`gblur=sigma=${n5(cp.blur * k)}`, 'format=rgba');
    }

    let cur = L('l');
    chains.push(`${src}${f.join(',')}[${cur}]`);
    const nFr = still ? 1 : N;

    if (cp && cp.vignette > 0.005) {
      const v = L('vg');
      chains.push(
        `color=c=black:s=${w}x${h}:r=${fps}:d=${frameDur},format=rgba,geq=r=0:g=0:b=0:a=${ffVignetteAlphaExpr(cp.vignette)}${loopTo(nFr)}[${v}]`
      );
      const o = L('l');
      chains.push(`[${cur}]format=rgba[${o}a];[${o}a][${v}]overlay=0:0:format=rgb[${o}]`);
      cur = o;
      rgba = true;
    }
    const mexpr = clip.type !== 'text' ? ffMaskExpr(clip.mask) : null;
    if (mexpr) {
      const mk = L('mk');
      chains.push(`color=c=black:s=${w}x${h}:r=${fps}:d=${frameDur},format=gray,geq=lum=${mexpr}${loopTo(nFr)}[${mk}]`);
      const o = L('l');
      chains.push(`[${cur}]format=rgba[${o}a];[${o}a][${mk}]alphamerge[${o}]`);
      cur = o;
      rgba = true;
    }

    const post = [];
    const op = clamp(clip.transform.opacity ?? 1, 0, 1);
    if (op < 0.999) post.push(`colorchannelmixer=aa=${n5(op)}`);
    const rot = (clip.transform.rotation || 0) % 360;
    if (Math.abs(rot) > 0.01) {
      const a = n5((rot * Math.PI) / 180);
      post.push(`rotate=a=${a}:ow=rotw(${a}):oh=roth(${a}):c=none`);
    }
    if (post.length && !rgba) {
      post.unshift('format=rgba');
      rgba = true;
    }

    const anim = [...ffFadeFilters(motion)];
    if (anim.length && !rgba) {
      anim.unshift('format=rgba');
      rgba = true;
    }
    const ex = ffMotionExprs(motion, 't', k);
    if (ex.scale) {
      anim.push(`scale=w=max(2\\,trunc(iw*(${ex.scale})/2)*2):h=max(2\\,trunc(ih*(${ex.scale})/2)*2):eval=frame`);
    }

    const tail = [...post];
    let isStill = still;
    if (still && (!keepStill || anim.length || !motionIsStatic(motion))) {
      tail.push(`loop=loop=${Math.max(0, N - 1)}:size=1:start=0`, `settb=1/${fps}`, 'setpts=N');
      isStill = false;
    }
    tail.push(...anim);
    if (tail.length) {
      const o = L('l');
      chains.push(`[${cur}]${tail.join(',')}[${o}]`);
      cur = o;
    }

    const cx = W / 2 + (clip.transform.x || 0) * k;
    const cy = H / 2 + (clip.transform.y || 0) * k;
    const covers =
      isOpaqueVideo &&
      motionIsStatic(motion) &&
      !mexpr &&
      op >= 0.999 &&
      Math.abs(rot) <= 0.01 &&
      Math.abs(w - W) <= 2 &&
      Math.abs(h - H) <= 2 &&
      Math.abs(cx - W / 2) < 0.5 &&
      Math.abs(cy - H / 2) < 0.5;
    const pos = (tv) => {
      const e = ffMotionExprs(motion, tv, k);
      return {
        x: `${n5(cx)}-overlay_w/2${e.dx ? `+${e.dx}` : ''}`,
        y: `${n5(cy)}-overlay_h/2${e.dy ? `+${e.dy}` : ''}`,
      };
    };
    return { label: cur, still: isStill, covers, pos };
  }

  function gapSeg(nFrames) {
    const g = L('gap');
    chains.push(`color=c=${bg}:s=${W}x${H}:r=${fps}:d=${n5((nFrames + 1) / fps)},trim=end_frame=${nFrames},format=yuv420p,setsar=1[${g}]`);
    return g;
  }

  // Un clip de la pista principal convertido en "marco" W×H opaco de N cuadros.
  function baseFrame(item) {
    const N = item.e - item.s;
    const clip = item.clip;
    const motion = clipMotion(clip, N / fps, PW, PH);
    const layer = layerChain(clip, N, motion, motionIsStatic(motion));
    if (!layer) return gapSeg(N);
    const out = L('fr');
    const wantBlur = clip.bgFill === 'blur' && (clip.type === 'video' || clip.type === 'image') && media.get(clip.mediaId);
    if (layer.still) {
      const p = layer.pos('t');
      let b;
      if (wantBlur) b = blurBackground(clip, 1, true);
      else {
        b = L('bg');
        chains.push(`color=c=${bg}:s=${W}x${H}:r=${fps}:d=${frameDur}[${b}]`);
      }
      chains.push(
        `[${b}][${layer.label}]overlay=x=${p.x}:y=${p.y}:format=auto,format=yuv420p,setsar=1${loopTo(N)}[${out}]`
      );
    } else if (layer.covers) {
      chains.push(`[${layer.label}]scale=${W}:${H},format=yuv420p,setsar=1[${out}]`);
    } else {
      const p = layer.pos('t');
      let b;
      if (wantBlur) b = blurBackground(clip, N, false);
      else {
        b = L('bg');
        chains.push(`color=c=${bg}:s=${W}x${H}:r=${fps}:d=${n5((N + 1) / fps)}[${b}]`);
      }
      chains.push(
        `[${b}][${layer.label}]overlay=x=${p.x}:y=${p.y}:eof_action=pass,trim=end_frame=${N},format=yuv420p,setsar=1[${out}]`
      );
    }
    return out;
  }

  // Segmento de transición: mezcla el final de A con el inicio de B (ambos marcos W×H).
  function transitionSeg(aTail, bHead, type, ov) {
    const d = ov / fps;
    const fx = transitionFx(type, d, PW, PH);
    const order = fx.top === 'A' ? [['B', bHead], ['A', aTail]] : [['A', aTail], ['B', bHead]];
    let cur = null;
    for (const [role, lbl] of order) {
      const m = fx[role];
      if (cur === null && motionIsStatic(m)) {
        cur = lbl;
        continue;
      }
      if (cur === null) {
        cur = L('tb');
        chains.push(`color=c=${bg}:s=${W}x${H}:r=${fps}:d=${n5((ov + 1) / fps)},trim=end_frame=${ov}[${cur}]`);
      }
      let srcL = lbl;
      const f = ['format=rgba'];
      if (m.reveal) {
        const mk = L('rv');
        chains.push(
          `color=c=black:s=${even(W / 4)}x${even(H / 4)}:r=${fps}:d=${n5((ov + 1) / fps)},format=gray,geq=lum=${ffRevealExpr(m.reveal)},scale=${W}:${H},trim=end_frame=${ov}[${mk}]`
        );
        const o = L('rm');
        chains.push(`[${srcL}]format=rgba[${o}a];[${o}a][${mk}]alphamerge[${o}]`);
        srcL = o;
      }
      f.push(...ffFadeFilters(m));
      const e = ffMotionExprs(m, 't', k);
      if (e.scale) f.push(`scale=w=max(2\\,trunc(iw*(${e.scale})/2)*2):h=max(2\\,trunc(ih*(${e.scale})/2)*2):eval=frame`);
      const prepared = L('tp');
      chains.push(`[${srcL}]${f.join(',')}[${prepared}]`);
      const x = `(W-overlay_w)/2${e.dx ? `+${e.dx}` : ''}`;
      const y = `(H-overlay_h)/2${e.dy ? `+${e.dy}` : ''}`;
      const o = L('tc');
      chains.push(`[${cur}][${prepared}]overlay=x=${x}:y=${y}:eof_action=pass[${o}]`);
      cur = o;
    }
    const out = L('ts');
    chains.push(`[${cur}]trim=end_frame=${ov},format=yuv420p,setsar=1[${out}]`);
    return out;
  }

  const baseItems = mainTrackFrames(project, fps);
  const baseTrack = mainTrack(project);
  const baseVisible = baseTrack && !baseTrack.hidden;

  // ---------------- Video ----------------
  if (includeVideo) {
    const segs = [];
    let pos = 0;
    let prevTail = null;
    const items = baseVisible ? baseItems : [];
    for (const it of items) {
      const N = it.e - it.s;
      if (it.head === 0 && it.s > pos) {
        segs.push(gapSeg(it.s - pos));
        pos = it.s;
      }
      const fr = baseFrame(it);
      const list = [];
      if (it.head > 0) list.push(['h', 0, it.head]);
      if (N - it.head - it.tail > 0) list.push(['b', it.head, N - it.tail]);
      if (it.tail > 0) list.push(['t', N - it.tail, N]);
      const parts = {};
      if (list.length === 1 && it.head === 0 && it.tail === 0) {
        parts.b = fr;
      } else if (list.length === 1) {
        const [key, a, b] = list[0];
        const l = L(key);
        chains.push(`[${fr}]trim=start_frame=${a}:end_frame=${b},setpts=PTS-STARTPTS[${l}]`);
        parts[key] = l;
      } else {
        const labels = list.map(([key]) => L(key));
        chains.push(`[${fr}]split=${list.length}${labels.map((l) => `[${l}s]`).join('')}`);
        list.forEach(([key, a, b], j) => {
          chains.push(`[${labels[j]}s]trim=start_frame=${a}:end_frame=${b},setpts=PTS-STARTPTS[${labels[j]}]`);
          parts[key] = labels[j];
        });
      }
      if (it.head > 0 && prevTail) {
        segs.push(transitionSeg(prevTail, parts.h, it.transition, it.head));
        pos = it.s + it.head;
      }
      if (parts.b) {
        segs.push(parts.b);
        pos = it.e - it.tail;
      }
      prevTail = parts.t || null;
      if (!parts.t) pos = it.e;
    }
    if (TF > pos) segs.push(gapSeg(TF - pos));

    let cur;
    if (segs.length === 1) cur = segs[0];
    else {
      cur = L('base');
      chains.push(`${segs.map((s) => `[${s}]`).join('')}concat=n=${segs.length}:v=1:a=0[${cur}]`);
    }

    const uppers = videoTracks(project).slice(0, -1).reverse();
    for (const tr of uppers) {
      if (tr.hidden) continue;
      for (const clip of trackClips(project, tr.id)) {
        if (!isVisual(clip)) continue;
        const s = F(clip.start);
        const e = Math.min(TF, F(clipEnd(clip)));
        const N = e - s;
        if (N <= 0) continue;
        const motion = clipMotion(clip, N / fps, PW, PH);
        const layer = layerChain(clip, N, motion, false);
        if (!layer) continue;
        const start = n5(s / fps);
        const sh = L('ov');
        chains.push(`[${layer.label}]setpts=PTS+${start}/TB[${sh}]`);
        const p = layer.pos(`(t-${start})`);
        const o = L('v');
        chains.push(`[${cur}][${sh}]overlay=x=${p.x}:y=${p.y}:eof_action=pass[${o}]`);
        cur = o;
      }
    }

    // Importante: quien ejecute FFmpeg debe pasar "-r fps" a la salida; si no, una imagen
    // del proyecto podría imponer 25 fps y se perderían fotogramas.
    if (opts.gif) {
      const g = L('g');
      chains.push(
        `[${cur}]split[${g}a][${g}b];[${g}a]palettegen=stats_mode=single[${g}p];[${g}b][${g}p]paletteuse=new=1:dither=bayer:bayer_scale=4[vout]`
      );
    } else {
      chains.push(`[${cur}]format=yuv420p[vout]`);
    }
  }

  // ---------------- Audio ----------------
  if (includeAudio) {
    const baseInfo = new Map(baseItems.map((it) => [it.clip.id, it]));
    const parts = [];
    for (const clip of project.clips) {
      const tr = tracks.get(clip.trackId);
      if (!tr || tr.muted) continue;
      const m = media.get(clip.mediaId);
      if (!clipHasAudio(clip, m) || !m?.path) continue;
      const vol = clip.volume ?? 1;
      if (vol <= 0.0001) continue;
      const info = baseInfo.get(clip.id);
      let s = F(clip.start);
      let e = Math.min(TF, F(clipEnd(clip)));
      if (info) {
        s = info.s;
        e = info.e;
      }
      const N = e - s;
      if (N <= 0) continue;
      const D = N / fps;
      const speed = clip.speed || 1;
      const inPoint = clamp(clip.in || 0, 0, Math.max(0, (m.duration || 0) - 0.05));
      const seekable = canSeek(m);
      let srcA;
      const pre = [];
      if (useMovie) srcA = movieSrc(m.path, true, inPoint, D * speed + 0.25, m.start || 0, seekable);
      else if (seekable) srcA = `[${addInput(['-ss', n5(inPoint), '-t', n5(D * speed + 0.25), '-i', m.path])}:a]`;
      else {
        srcA = `[${addInput(['-i', m.path])}:a]`;
        pre.push(`atrim=start=${n5(inPoint)}:duration=${n5(D * speed + 0.25)}`);
      }
      const f = [
        ...pre,
        'aresample=48000',
        'aformat=sample_fmts=fltp:channel_layouts=stereo',
        'asetpts=PTS-STARTPTS',
        ...atempoChain(speed),
        `apad=whole_dur=${n5(D)}`,
        `atrim=duration=${n5(D)}`,
      ];
      if (Math.abs(vol - 1) > 1e-4) f.push(`volume=${n5(vol)}`);
      const fi = Math.min(clip.fadeIn || 0, D);
      const fo = Math.min(clip.fadeOut || 0, D);
      if (fi > 0.01) f.push(`afade=t=in:st=0:d=${n5(fi)}`);
      if (fo > 0.01) f.push(`afade=t=out:st=${n5(D - fo)}:d=${n5(fo)}`);
      if (info?.head) f.push(`afade=t=in:st=0:d=${n5(info.head / fps)}`);
      if (info?.tail) f.push(`afade=t=out:st=${n5((N - info.tail) / fps)}:d=${n5(info.tail / fps)}`);
      const ms = Math.round((s / fps) * 1000);
      if (ms > 0) f.push(`adelay=delays=${ms}:all=1`);
      const lab = L('a');
      chains.push(`${srcA}${f.join(',')}[${lab}]`);
      parts.push(lab);
    }
    const sil = L('sil');
    chains.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${n5(total)}[${sil}]`);
    if (parts.length) {
      chains.push(
        `[${sil}]${parts.map((p) => `[${p}]`).join('')}amix=inputs=${parts.length + 1}:duration=first:dropout_transition=0:normalize=0[aout]`
      );
    } else {
      chains.push(`[${sil}]anull[aout]`);
    }
  }

  return {
    inputs,
    filter: chains.join(';\n'),
    vout: includeVideo ? '[vout]' : null,
    aout: includeAudio ? '[aout]' : null,
    total,
    frames: TF,
    width: W,
    height: H,
    warnings,
  };
}

// Elige automáticamente entre entradas "-i" (lo normal) y fuentes "movie" si la orden sería demasiado larga.
export const MAX_ARGS_LENGTH = 24000;
export function buildExportGraphAuto(project, opts, assets = {}) {
  const g = buildExportGraph(project, { ...opts, movieSources: false }, assets);
  const len = g.inputs.flat().reduce((s, a) => s + String(a).length + 3, 0);
  if (len <= MAX_ARGS_LENGTH && !opts.movieSources) return g;
  return buildExportGraph(project, { ...opts, movieSources: true }, assets);
}

// Textos que hay que renderizar como PNG antes de exportar (todos los clips de texto visibles).
export function textClipsToRender(project) {
  const hidden = new Set(project.tracks.filter((t) => t.hidden).map((t) => t.id));
  return project.clips.filter((c) => c.type === 'text' && !hidden.has(c.trackId));
}
