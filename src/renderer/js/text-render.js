// Dibujo de textos en un canvas. Se usa tanto en la vista previa como para exportar (PNG),
// así el texto exportado es idéntico al que se ve en pantalla.

export const FONTS = [
  { family: 'Montserrat', weights: [400, 700, 900] },
  { family: 'Poppins', weights: [400, 600, 800] },
  { family: 'Oswald', weights: [400, 700] },
  { family: 'Bebas Neue', weights: [400] },
  { family: 'Anton', weights: [400] },
  { family: 'Bangers', weights: [400] },
  { family: 'Permanent Marker', weights: [400] },
  { family: 'Pacifico', weights: [400] },
  { family: 'Lobster', weights: [400] },
  { family: 'Dancing Script', weights: [400, 700] },
  { family: 'Caveat', weights: [400, 700] },
  { family: 'Playfair Display', weights: [400, 700, 900] },
  { family: 'Arial', system: true },
  { family: 'Georgia', system: true },
  { family: 'Times New Roman', system: true },
  { family: 'Courier New', system: true },
  { family: 'Verdana', system: true },
  { family: 'Trebuchet MS', system: true },
  { family: 'Impact', system: true },
  { family: 'Comic Sans MS', system: true },
];

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

export const TEXT_PRESETS = [
  { id: 'title', name: 'Título', text: { content: 'TÍTULO', font: 'Montserrat', weight: 900, size: 120, color: '#ffffff', shadowBlur: 12, shadowY: 4, shadowOpacity: 0.5 } },
  { id: 'subtitle', name: 'Subtítulo', text: { content: 'Escribe tu subtítulo aquí', font: 'Poppins', weight: 600, size: 52, color: '#ffffff', bgOpacity: 0.6, bgColor: '#000000', bgPadding: 18, bgRadius: 10 }, y: 380 },
  { id: 'outline', name: 'Contorno', text: { content: 'CONTORNO', font: 'Bebas Neue', weight: 400, size: 140, color: '#ffffff', strokeColor: '#000000', strokeWidth: 7 } },
  { id: 'yellow', name: 'Impacto', text: { content: '¡INCREÍBLE!', font: 'Anton', weight: 400, size: 120, color: '#ffd400', strokeColor: '#111111', strokeWidth: 6, shadowBlur: 0, shadowX: 6, shadowY: 6, shadowOpacity: 0.9 } },
  { id: 'neon', name: 'Neón', text: { content: 'Neón', font: 'Poppins', weight: 800, size: 110, color: '#c8fffb', shadowColor: '#00f0ff', shadowBlur: 28, shadowOpacity: 1 } },
  { id: 'comic', name: 'Cómic', text: { content: '¡POW!', font: 'Bangers', weight: 400, size: 140, color: '#ffffff', strokeColor: '#1b1b1b', strokeWidth: 7, shadowX: 7, shadowY: 7, shadowOpacity: 1, shadowColor: '#ff3d5a' } },
  { id: 'script', name: 'Manuscrito', text: { content: 'Hola', font: 'Pacifico', weight: 400, size: 110, color: '#ffffff', shadowBlur: 10, shadowY: 3, shadowOpacity: 0.55 } },
  { id: 'elegant', name: 'Elegante', text: { content: 'Elegante', font: 'Playfair Display', weight: 700, italic: true, size: 100, color: '#f5e6c8' } },
  { id: 'label', name: 'Etiqueta', text: { content: 'NUEVO', font: 'Montserrat', weight: 700, size: 48, color: '#111111', bgColor: '#ffd400', bgOpacity: 1, bgPadding: 16, bgRadius: 8, letterSpacing: 2 } },
  { id: 'marker', name: 'Marcador', text: { content: 'Importante', font: 'Permanent Marker', weight: 400, size: 96, color: '#ff4d6d' } },
  { id: 'retro', name: 'Retro', text: { content: 'Retro', font: 'Lobster', weight: 400, size: 120, color: '#ff9f1c', strokeColor: '#2b2d42', strokeWidth: 5 } },
  { id: 'minimal', name: 'Minimal', text: { content: 'minimal', font: 'Montserrat', weight: 400, size: 64, color: '#ffffff', letterSpacing: 14, uppercase: true } },
  { id: 'lower', name: 'Rótulo', text: { content: 'Nombre Apellido\nCargo o descripción', font: 'Poppins', weight: 600, size: 46, color: '#ffffff', align: 'left', bgColor: '#14d4c4', bgOpacity: 0.92, bgPadding: 22, bgRadius: 6, lineHeight: 1.3 }, x: -520, y: 360 },
  { id: 'handwrite', name: 'Notas', text: { content: 'Nota rápida', font: 'Caveat', weight: 700, size: 96, color: '#ffffff', shadowBlur: 6, shadowOpacity: 0.5 } },
];

export const STICKERS = ['😀', '😂', '🤣', '😍', '🤩', '😎', '🥳', '😮', '😱', '😢', '😡', '🤔', '👍', '👎', '👏', '🙌', '🙏', '💪', '🔥', '✨', '⭐', '💯', '❤️', '💔', '🎉', '🎁', '🎂', '📌', '📍', '✅', '❌', '⚠️', '❓', '❗', '💡', '🚀', '🎬', '🎵', '🎮', '📱', '💻', '⏰', '📢', '👉', '👈', '👆', '👇', '➡️', '⬅️', '⬆️', '⬇️', '💥', '💬', '👀', '🤯', '😴'];
