// Compositor de la vista previa: dibuja el proyecto en un instante dado sobre un canvas 2D.
// Usa la misma geometría, color y movimiento que la exportación (módulos compartidos).
import { mainTrack, isVisual } from '../shared/model.js';
import { colorPipeline, colorKey, svgMatrixValues, vignetteAlpha, evalMotion, clipMotion, roundedRadius, BG_BLUR, bgBlurSigma, flashAlpha } from '../shared/effects.js';
import { cropRect, mainTrackItems, mainFramesAt, overlayClipsAt } from '../shared/layout.js';
import { cachedTextCanvas } from './text-render.js';

// ---------- Filtros de color SVG (idénticos a lutrgb + colorchannelmixer de FFmpeg) ----------
const SVG_NS = 'http://www.w3.org/2000/svg';
let svgDefs = null;
const filterIds = new Map();
let filterSeq = 0;

function ensureSvgFilter(cp) {
  const key = colorKey(cp);
  let id = filterIds.get(key);
  if (id) return id;
  if (!svgDefs) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('width', '0');
    svg.setAttribute('height', '0');
    svg.style.position = 'absolute';
    svg.style.pointerEvents = 'none';
    svgDefs = document.createElementNS(SVG_NS, 'defs');
    svg.append(svgDefs);
    document.body.append(svg);
  }
  id = `cf${++filterSeq}`;
  const f = document.createElementNS(SVG_NS, 'filter');
  f.setAttribute('id', id);
  f.setAttribute('color-interpolation-filters', 'sRGB');
  f.setAttribute('x', '0');
  f.setAttribute('y', '0');
  f.setAttribute('width', '1');
  f.setAttribute('height', '1');
  if (cp.hasLinear) {
    const ct = document.createElementNS(SVG_NS, 'feComponentTransfer');
    for (const ch of ['R', 'G', 'B']) {
      const fn = document.createElementNS(SVG_NS, `feFunc${ch}`);
      fn.setAttribute('type', 'linear');
      fn.setAttribute('slope', String(cp.slope));
      fn.setAttribute('intercept', String(cp.intercept));
      ct.append(fn);
    }
    f.append(ct);
  }
  if (cp.hasMatrix) {
    const cm = document.createElementNS(SVG_NS, 'feColorMatrix');
    cm.setAttribute('type', 'matrix');
    cm.setAttribute('values', svgMatrixValues(cp.matrix));
    f.append(cm);
  }
  svgDefs.append(f);
  filterIds.set(key, id);
  return id;
}

export function cssFilterFor(adjust, scale) {
  const cp = colorPipeline(adjust);
  let s = '';
  if (cp.hasLinear || cp.hasMatrix) s += `url(#${ensureSvgFilter(cp)}) `;
  if (cp.blur > 0.01) s += `blur(${(cp.blur * scale).toFixed(2)}px)`;
  return { filter: s.trim() || 'none', cp };
}

// ---------- Viñeta (misma fórmula que la exportación) ----------
const vignetteCache = new Map();
function vignetteCanvas(w, h, strength) {
  w = Math.max(2, Math.round(w));
  h = Math.max(2, Math.round(h));
  const key = `${w}x${h}@${strength.toFixed(3)}`;
  let c = vignetteCache.get(key);
  if (c) return c;
  // Se calcula a menor resolución y se escala (la viñeta es suave).
  const sw = Math.max(2, Math.round(w / 4));
  const sh = Math.max(2, Math.round(h / 4));
  const small = document.createElement('canvas');
  small.width = sw;
  small.height = sh;
  const sctx = small.getContext('2d');
  const img = sctx.createImageData(sw, sh);
  for (let y = 0; y < sh; y++) {
    const ny = ((y + 0.5) / sh) * 2 - 1;
    for (let x = 0; x < sw; x++) {
      const nx = ((x + 0.5) / sw) * 2 - 1;
      img.data[(y * sw + x) * 4 + 3] = Math.round(vignetteAlpha(nx, ny, strength) * 255);
    }
  }
  sctx.putImageData(img, 0, 0);
  c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  c.getContext('2d').drawImage(small, 0, 0, w, h);
  vignetteCache.set(key, c);
  if (vignetteCache.size > 12) vignetteCache.delete(vignetteCache.keys().next().value);
  return c;
}

// Lienzos temporales reutilizables.
const scratch = [];
function scratchCanvas(i, w, h) {
  let c = scratch[i];
  if (!c) {
    c = document.createElement('canvas');
    scratch[i] = c;
  }
  w = Math.max(1, Math.round(w));
  h = Math.max(1, Math.round(h));
  if (c.width !== w || c.height !== h) {
    c.width = w;
    c.height = h;
  } else c.getContext('2d').clearRect(0, 0, w, h);
  return c;
}

/**
 * Dibuja el proyecto en el instante t.
 * env: { scale, getVideo(clip), getImage(mediaId), getMedia(id), project }
 */
export function drawFrame(ctx, t, env) {
  const p = env.project;
  const PW = p.settings.width;
  const PH = p.settings.height;
  const s = env.scale;
  const cw = ctx.canvas.width;
  const ch = ctx.canvas.height;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.filter = 'none';
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = p.settings.background || '#000';
  ctx.fillRect(0, 0, cw, ch);
  const base = mainTrack(p);
  if (base && !base.hidden) {
    const items = env.mainItems || mainTrackItems(p);
    const frames = mainFramesAt(items, t, PW, PH);
    for (const fr of frames) drawMainFrame(ctx, fr, t, env, cw, ch);
  }
  for (const clip of overlayClipsAt(p, t)) drawLayer(ctx, clip, t - clip.start, env, cw, ch);
  // Efecto «Destello»: fogonazo blanco por encima de todo (igual que en la exportación).
  for (const clip of p.clips) {
    const a = flashAlpha(clip, t - clip.start);
    if (a <= 0.001 || !isVisual(clip) || p.tracks.find((tr) => tr.id === clip.trackId)?.hidden) continue;
    ctx.globalAlpha = a;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, cw, ch);
  }
  ctx.restore();
}

// Fondo desenfocado de la pista principal (misma receta que la exportación).
function drawBlurFill(ctx, clip, env, cw, ch) {
  if (clip.bgFill !== 'blur' || (clip.type !== 'video' && clip.type !== 'image')) return;
  const m = env.getMedia(clip.mediaId);
  const src = m && (clip.type === 'image' ? env.getImage(clip.mediaId) : env.getVideo(clip));
  if (!src) return;
  const iw = src.videoWidth || src.naturalWidth || src.width;
  const ih = src.videoHeight || src.naturalHeight || src.height;
  if (!iw || !ih) return;
  const r = cropRect(clip, m);
  const fx = iw / m.width;
  const fy = ih / m.height;
  const cover = Math.max(cw / r.w, ch / r.h) * BG_BLUR.overscale;
  const w = r.w * cover;
  const h = r.h * cover;
  const p = env.project.settings;
  ctx.save();
  ctx.filter = `blur(${(bgBlurSigma(p.width, p.height) * env.scale).toFixed(2)}px) brightness(${BG_BLUR.darken})`;
  ctx.drawImage(src, r.x * fx, r.y * fy, r.w * fx, r.h * fy, (cw - w) / 2, (ch - h) / 2, w, h);
  ctx.restore();
}

function drawMainFrame(ctx, fr, t, env, cw, ch) {
  const clip = fr.item.clip;
  const ev = evalMotion(fr.motion, fr.u);
  const identity = ev.alpha >= 0.999 && Math.abs(ev.dx) < 0.01 && Math.abs(ev.dy) < 0.01 && Math.abs(ev.scale - 1) < 1e-4 && !ev.reveal;
  if (identity) {
    ctx.fillStyle = env.project.settings.background || '#000';
    ctx.fillRect(0, 0, cw, ch);
    drawBlurFill(ctx, clip, env, cw, ch);
    drawLayer(ctx, clip, t - clip.start, env, cw, ch);
    return;
  }
  if (ev.alpha <= 0.001) return;
  // En una transición el marco (fondo + clip) se compone aparte y se mueve/funde como una unidad.
  const off = scratchCanvas(1, cw, ch);
  const octx = off.getContext('2d');
  octx.fillStyle = env.project.settings.background || '#000';
  octx.fillRect(0, 0, cw, ch);
  drawBlurFill(octx, clip, env, cw, ch);
  drawLayer(octx, clip, t - clip.start, env, cw, ch);
  ctx.save();
  if (ev.reveal) {
    ctx.beginPath();
    const p = ev.reveal.p;
    if (ev.reveal.type === 'wipe-left') ctx.rect(cw * (1 - p), 0, cw * p + 1, ch);
    else if (ev.reveal.type === 'wipe-right') ctx.rect(0, 0, cw * p, ch);
    else ctx.arc(cw / 2, ch / 2, (Math.hypot(cw, ch) / 2) * p, 0, Math.PI * 2);
    ctx.clip();
  }
  ctx.globalAlpha = ev.alpha;
  ctx.translate(cw / 2 + ev.dx * env.scale, ch / 2 + ev.dy * env.scale);
  ctx.scale(ev.scale, ev.scale);
  ctx.drawImage(off, -cw / 2, -ch / 2);
  ctx.restore();
}

// Dibuja un clip (capa) en su tiempo local.
export function drawLayer(ctx, clip, local, env, cw, ch) {
  const p = env.project;
  const PW = p.settings.width;
  const PH = p.settings.height;
  const s = env.scale;
  const motion = clipMotion(clip, clip.duration, PW, PH);
  const ev = evalMotion(motion, local);
  const tr = clip.transform;
  const alpha = Math.max(0, Math.min(1, (tr.opacity ?? 1) * ev.alpha));
  if (alpha <= 0.001) return;

  let source = null;
  let sx = 0;
  let sy = 0;
  let sw = 0;
  let shh = 0;
  let w;
  let h;
  if (clip.type === 'text') {
    source = cachedTextCanvas(clip, s * (tr.scale || 1));
    w = source.width;
    h = source.height;
    sw = w;
    shh = h;
  } else {
    const m = env.getMedia(clip.mediaId);
    if (!m) return;
    if (clip.type === 'image') source = env.getImage(clip.mediaId);
    else source = env.getVideo(clip);
    if (!source) return;
    const iw = source.videoWidth || source.naturalWidth || source.width;
    const ih = source.videoHeight || source.naturalHeight || source.height;
    if (!iw || !ih) return;
    const r = cropRect(clip, m);
    const fx = iw / m.width;
    const fy = ih / m.height;
    sx = r.x * fx;
    sy = r.y * fy;
    sw = r.w * fx;
    shh = r.h * fy;
    const fit = Math.min(PW / r.w, PH / r.h);
    w = r.w * fit * (tr.scale || 1) * s;
    h = r.h * fit * (tr.scale || 1) * s;
  }
  if (w < 0.5 || h < 0.5) return;

  const { filter, cp } = clip.type === 'text' ? { filter: 'none', cp: null } : cssFilterFor(clip.adjust, s);
  const vign = cp && cp.vignette > 0.005;
  const mask = clip.type !== 'text' && clip.mask && clip.mask !== 'none' ? clip.mask : null;

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(cw / 2 + ((tr.x || 0) + ev.dx) * s, ch / 2 + ((tr.y || 0) + ev.dy) * s);
  if (tr.rotation) ctx.rotate((tr.rotation * Math.PI) / 180);
  ctx.scale(ev.scale * (tr.flipH ? -1 : 1), ev.scale * (tr.flipV ? -1 : 1));
  if (!vign) {
    if (mask) {
      ctx.beginPath();
      if (mask === 'circle') ctx.arc(0, 0, Math.min(w, h) / 2, 0, Math.PI * 2);
      else ctx.roundRect(-w / 2, -h / 2, w, h, roundedRadius(w, h));
      ctx.clip();
    }
    ctx.filter = filter;
    ctx.drawImage(source, sx, sy, sw, shh, -w / 2, -h / 2, w, h);
  } else {
    // Capa intermedia: imagen + color + viñeta + máscara, y luego se transforma.
    const layer = scratchCanvas(5, w, h);
    const l = layer.getContext('2d');
    l.filter = filter;
    l.drawImage(source, sx, sy, sw, shh, 0, 0, layer.width, layer.height);
    l.filter = 'none';
    l.globalCompositeOperation = 'source-atop';
    l.drawImage(vignetteCanvas(layer.width, layer.height, cp.vignette), 0, 0);
    if (mask) {
      l.globalCompositeOperation = 'destination-in';
      l.beginPath();
      if (mask === 'circle') l.arc(layer.width / 2, layer.height / 2, Math.min(layer.width, layer.height) / 2, 0, Math.PI * 2);
      else l.roundRect(0, 0, layer.width, layer.height, roundedRadius(layer.width, layer.height));
      l.fill();
    }
    l.globalCompositeOperation = 'source-over';
    ctx.drawImage(layer, -w / 2, -h / 2, w, h);
  }
  ctx.restore();
}

// Rectángulo (en px del proyecto) que ocupa un clip, sin animaciones. Para los controles del visor.
export function clipBox(clip, project, getMedia, textScale = 1) {
  const PW = project.settings.width;
  const PH = project.settings.height;
  const tr = clip.transform;
  let w;
  let h;
  if (clip.type === 'text') {
    const c = cachedTextCanvas(clip, textScale * (tr.scale || 1));
    w = c.width / textScale;
    h = c.height / textScale;
  } else {
    const m = getMedia(clip.mediaId);
    if (!m) return null;
    const r = cropRect(clip, m);
    const fit = Math.min(PW / r.w, PH / r.h);
    w = r.w * fit * (tr.scale || 1);
    h = r.h * fit * (tr.scale || 1);
  }
  return { cx: PW / 2 + (tr.x || 0), cy: PH / 2 + (tr.y || 0), w, h, rotation: tr.rotation || 0 };
}
