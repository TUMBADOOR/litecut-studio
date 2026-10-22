// Dibujo de textos en un canvas. Se usa tanto en la vista previa como para exportar (PNG),
// así el texto exportado es idéntico al que se ve en pantalla.

export { FONTS, TEXT_PRESETS } from '../shared/text-presets.js';

const EMOJI_FALLBACK = '"Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif';

export function fontString(t, scale) {
  return `${t.italic ? 'italic ' : ''}${t.weight || 400} ${Math.max(1, t.size * scale)}px "${t.font}", ${EMOJI_FALLBACK}`;
}

const loaded = new Set();
// Carga la fuente antes de dibujar (las fuentes web se cargan bajo demanda).
export function ensureFont(t) {
  const key = `${t.font}|${t.weight}|${t.italic}`;
  if (loaded.has(key)) return Promise.resolve(true);
  return document.fonts
    .load(fontString(t, 0.5), t.content || 'Aa')
    .then(() => {
      if (!loaded.has(key)) {
        loaded.add(key);
        // Avisa una sola vez por fuente para volver a dibujar textos y vistas previas.
        window.dispatchEvent(new Event('litecut:fonts'));
      }
      return true;
    })
    .catch(() => false);
}

export function fontReady(t) {
  return loaded.has(`${t.font}|${t.weight}|${t.italic}`);
}

export function hexToRgba(hex, a = 1) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  const n = m ? parseInt(m[1], 16) : 0;
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

export function renderTextCanvas(t, scale, canvas = document.createElement('canvas')) {
  const size = Math.max(1, t.size * scale);
  const font = fontString(t, scale);
  const content = (t.uppercase ? (t.content || '').toUpperCase() : t.content || '') || ' ';
  const lines = content.split('\n');
  const ctx = canvas.getContext('2d');
  const setup = () => {
    ctx.font = font;
    ctx.letterSpacing = `${(t.letterSpacing || 0) * scale}px`;
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.miterLimit = 2;
  };
  setup();
  const widths = lines.map((l) => ctx.measureText(l || ' ').width);
  const lh = size * (t.lineHeight || 1.15);
  const maxW = Math.max(1, ...widths);
  const hasBg = (t.bgOpacity || 0) > 0;
  const pad = hasBg ? (t.bgPadding || 0) * scale : 0;
  const stroke = Math.max(0, (t.strokeWidth || 0) * scale);
  const shadowOn = (t.shadowBlur || 0) > 0 || t.shadowX || t.shadowY;
  const sh = shadowOn ? (t.shadowBlur || 0) * scale * 1.5 + Math.max(Math.abs(t.shadowX || 0), Math.abs(t.shadowY || 0)) * scale : 0;
  const margin = Math.ceil(stroke + sh + 2);
  const boxW = maxW + pad * 2;
  const boxH = lines.length * lh + pad * 2;
  canvas.width = Math.max(2, Math.ceil(boxW + margin * 2));
  canvas.height = Math.max(2, Math.ceil(boxH + margin * 2));
  setup();
  if (hasBg) {
    ctx.fillStyle = hexToRgba(t.bgColor, t.bgOpacity);
    ctx.beginPath();
    ctx.roundRect(margin, margin, boxW, boxH, Math.min((t.bgRadius || 0) * scale, boxH / 2, boxW / 2));
    ctx.fill();
  }
  const align = t.align || 'center';
  ctx.textAlign = align;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const y = margin + pad + lh * (i + 0.5);
    const x = align === 'left' ? margin + pad : align === 'right' ? margin + pad + maxW : canvas.width / 2;
    if (shadowOn) {
      ctx.shadowColor = hexToRgba(t.shadowColor, t.shadowOpacity ?? 0.6);
      ctx.shadowBlur = (t.shadowBlur || 0) * scale;
      ctx.shadowOffsetX = (t.shadowX || 0) * scale;
      ctx.shadowOffsetY = (t.shadowY || 0) * scale;
    }
    if (stroke > 0) {
      ctx.strokeStyle = t.strokeColor || '#000';
      ctx.lineWidth = stroke * 2;
      ctx.strokeText(line, x, y);
      ctx.shadowColor = 'transparent';
    }
    ctx.fillStyle = t.color || '#fff';
    ctx.fillText(line, x, y);
    ctx.shadowColor = 'transparent';
  }
  return canvas;
}

// Caché de textos renderizados para la vista previa.
const cache = new Map();
export function cachedTextCanvas(clip, scale) {
  const t = clip.text;
  const key = `${clip.id}|${scale.toFixed(4)}|${JSON.stringify(t)}|${fontReady(t)}`;
  let c = cache.get(key);
  if (c) {
    cache.delete(key);
    cache.set(key, c);
    return c;
  }
  if (!fontReady(t)) ensureFont(t);
  c = renderTextCanvas(t, scale);
  cache.set(key, c);
  if (cache.size > 60) cache.delete(cache.keys().next().value);
  return c;
}

export async function textToPngBuffer(t, scale) {
  await ensureFont(t);
  const c = renderTextCanvas(t, scale);
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
  return { buffer: await blob.arrayBuffer(), w: c.width, h: c.height };
}

export const STICKERS = ['😀', '😂', '🤣', '😍', '🤩', '😎', '🥳', '😮', '😱', '😢', '😡', '🤔', '👍', '👎', '👏', '🙌', '🙏', '💪', '🔥', '✨', '⭐', '💯', '❤️', '💔', '🎉', '🎁', '🎂', '📌', '📍', '✅', '❌', '⚠️', '❓', '❗', '💡', '🚀', '🎬', '🎵', '🎮', '📱', '💻', '⏰', '📢', '👉', '👈', '👆', '👇', '➡️', '⬅️', '⬆️', '⬇️', '💥', '💬', '👀', '🤯', '😴'];
