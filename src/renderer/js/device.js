// Perfil del equipo (procesador, memoria, gráfica y qué códecs decodifica por hardware).
// Con él la app se adapta: los videos que este equipo no mueve con soltura se editan con una copia ligera.
const api = window.api;

// Tipos con los que se pregunta a Chromium si la gráfica decodifica cada códec.
const CODEC_TYPES = {
  h264: 'video/mp4; codecs="avc1.640028"',
  hevc: 'video/mp4; codecs="hvc1.1.6.L120.90"',
  vp9: 'video/webm; codecs="vp09.00.40.08"',
  vp8: 'video/webm; codecs="vp8"',
  av1: 'video/mp4; codecs="av01.0.08M.08"',
};

export const CODEC_NAMES = { h264: 'H.264', hevc: 'H.265', vp9: 'VP9', vp8: 'VP8', av1: 'AV1' };

let profile = null;
export function deviceProfile() {
  return (profile ||= api.device.profile().catch(() => ({ tier: 'mid', cores: navigator.hardwareConcurrency || 4 })));
}

const hwCache = new Map();
// ¿La gráfica decodifica este video? (Chromium lo indica como «powerEfficient»).
export function hwDecodes(vcodec, width, height, fps) {
  const contentType = CODEC_TYPES[vcodec];
  if (!contentType || !navigator.mediaCapabilities) return Promise.resolve(false);
  const framerate = Math.round(fps || 30);
  const key = `${vcodec}|${width}x${height}@${framerate}`;
  if (!hwCache.has(key)) {
    const q = { type: 'file', video: { contentType, width, height, framerate, bitrate: 8e6 } };
    hwCache.set(key, navigator.mediaCapabilities.decodingInfo(q).then((r) => !!(r.supported && r.powerEfficient), () => false));
  }
  return hwCache.get(key);
}

// Píxeles por segundo que cada tipo de equipo mueve con soltura: sin ayuda de la gráfica (CPU) y con ella.
const CPU_LIMIT = { low: 1280 * 720 * 30, mid: 1920 * 1080 * 30, high: 1920 * 1080 * 60 };
const GPU_LIMIT = { low: 1920 * 1088 * 60, mid: 3840 * 2160 * 30, high: Infinity };

// Motivo por el que un video es demasiado pesado para este equipo (o null si se reproduce bien).
export async function heavyReason(m) {
  if (m.kind !== 'video' || !m.hasVideo || !(m.width > 0)) return null;
  const prof = await deviceProfile();
  const tier = CPU_LIMIT[prof.tier] ? prof.tier : 'mid';
  const fps = Math.min(m.fps || 30, 120);
  const rate = m.width * m.height * fps;
  const label = `${CODEC_NAMES[m.vcodec] || (m.vcodec || '').toUpperCase()} ${Math.min(m.width, m.height)}p${Math.round(fps)}`;
  if (await hwDecodes(m.vcodec, m.width, m.height, fps)) return rate > GPU_LIMIT[tier] ? label : null;
  return rate > CPU_LIMIT[tier] ? label : null;
}
