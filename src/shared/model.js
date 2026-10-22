// Modelo de datos del proyecto. Compartido entre la interfaz (renderer) y el proceso principal.

export const APP_NAME = 'LiteCut Studio';
export const PROJECT_EXT = 'lcproj';
export const PROJECT_VERSION = 1;
export const MIN_CLIP = 0.1; // duración mínima de un clip (s)
export const DEFAULT_IMAGE_DURATION = 5;
export const DEFAULT_TEXT_DURATION = 4;

export const ASPECTS = [
  { id: '16:9', label: '16:9', sub: 'YouTube', w: 1920, h: 1080 },
  { id: '9:16', label: '9:16', sub: 'TikTok / Reels', w: 1080, h: 1920 },
  { id: '1:1', label: '1:1', sub: 'Instagram', w: 1080, h: 1080 },
  { id: '4:5', label: '4:5', sub: 'Instagram', w: 1080, h: 1350 },
  { id: '4:3', label: '4:3', sub: 'Clásico', w: 1440, h: 1080 },
  { id: '21:9', label: '21:9', sub: 'Cine', w: 2560, h: 1080 },
];

export const EXTENSIONS = {
  video: ['mp4', 'mov', 'm4v', 'mkv', 'webm', 'avi', 'wmv', 'flv', 'mpg', 'mpeg', 'ts', 'mts', 'm2ts', '3gp', 'ogv', 'gif'],
  audio: ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'flac', 'wma', 'aiff', 'aif'],
  image: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'tif', 'tiff'],
};

export function extOf(p) {
  const m = /\.([a-z0-9]+)$/i.exec(p || '');
  return m ? m[1].toLowerCase() : '';
}

export function mediaKindFromPath(p) {
  const e = extOf(p);
  for (const [kind, list] of Object.entries(EXTENSIONS)) if (list.includes(e)) return kind;
  return null;
}

export function baseName(p) {
  return String(p || '').split(/[\\/]/).pop();
}

let uidCounter = 0;
export function uid(prefix = 'id') {
  uidCounter = (uidCounter + 1) % 1679616;
  return `${prefix}_${Date.now().toString(36)}${uidCounter.toString(36).padStart(4, '0')}${Math.random().toString(36).slice(2, 6)}`;
}

export const clone = (o) => JSON.parse(JSON.stringify(o));

export function defaultTransform() {
  return { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, flipH: false, flipV: false };
}

export function defaultAdjust() {
  return { brightness: 0, contrast: 0, saturation: 0, hue: 0, temperature: 0, tint: 0, sepia: 0, grayscale: 0, blur: 0, vignette: 0 };
}

export function defaultText() {
  return {
    content: 'Tu texto aquí',
    font: 'Montserrat',
    weight: 800,
    italic: false,
    size: 96,
    color: '#ffffff',
    align: 'center',
    lineHeight: 1.15,
    letterSpacing: 0,
    uppercase: false,
    strokeColor: '#000000',
    strokeWidth: 0,
    shadowColor: '#000000',
    shadowOpacity: 0.6,
    shadowBlur: 0,
    shadowX: 0,
    shadowY: 0,
    bgColor: '#000000',
    bgOpacity: 0,
    bgPadding: 24,
    bgRadius: 14,
  };
}

export function createClip(type, props = {}) {
  const clip = {
    id: uid('clip'),
    type, // 'video' | 'audio' | 'image' | 'text'
    trackId: null,
    mediaId: null,
    name: '',
    start: 0,
    duration: type === 'text' ? DEFAULT_TEXT_DURATION : DEFAULT_IMAGE_DURATION,
    in: 0,
    speed: 1,
    volume: 1,
    muted: false,
    fadeIn: 0,
    fadeOut: 0,
    transform: defaultTransform(),
    crop: { l: 0, t: 0, r: 0, b: 0 },
    mask: 'none',
    adjust: defaultAdjust(),
    filter: 'none',
    animIn: { type: 'none', duration: 0.6 },
    animOut: { type: 'none', duration: 0.6 },
    kenburns: 'none',
    transitionIn: null,
    bgFill: 'none', // pista principal: 'none' (color de fondo) o 'blur' (el mismo video desenfocado)
    linkedTo: null, // audio separado: id del clip de video al que sigue
    effects: [], // efectos de clip: [{ type, intensity, period?, phase? }] (ver EFFECTS en effects.js)
    text: type === 'text' ? defaultText() : null,
  };
  return Object.assign(clip, props);
}

export function createTrack(kind) {
  return { id: uid('trk'), kind, muted: false, hidden: false, locked: false };
}

export function createProject(aspectId = '16:9') {
  const a = ASPECTS.find((x) => x.id === aspectId) || ASPECTS[0];
  return {
    app: APP_NAME,
    version: PROJECT_VERSION,
    name: 'Proyecto sin título',
    settings: { width: a.w, height: a.h, fps: 30, background: '#000000', aspect: a.id },
    media: [],
    tracks: [createTrack('video'), createTrack('audio')],
    clips: [],
    markers: [],
  };
}

// Completa campos faltantes (proyectos antiguos o editados a mano).
export function normalizeProject(p) {
  const base = createProject(p?.settings?.aspect || '16:9');
  const out = Object.assign(base, p || {});
  out.settings = Object.assign(createProject().settings, p?.settings || {});
  out.media = Array.isArray(p?.media) ? p.media : [];
  out.tracks = Array.isArray(p?.tracks) && p.tracks.length ? p.tracks.map((t) => Object.assign(createTrack(t.kind || 'video'), t)) : base.tracks;
  if (!out.tracks.some((t) => t.kind === 'video')) out.tracks.unshift(createTrack('video'));
  // Las pistas de video siempre van antes que las de audio.
  out.tracks = [...out.tracks.filter((t) => t.kind === 'video'), ...out.tracks.filter((t) => t.kind !== 'video')];
  const trackIds = new Set(out.tracks.map((t) => t.id));
  out.clips = (Array.isArray(p?.clips) ? p.clips : [])
    .filter((c) => trackIds.has(c.trackId))
    .map((c) => {
      const d = createClip(c.type || 'video');
      const n = Object.assign(d, c);
      n.transform = Object.assign(defaultTransform(), c.transform || {});
      n.adjust = Object.assign(defaultAdjust(), c.adjust || {});
      n.crop = Object.assign({ l: 0, t: 0, r: 0, b: 0 }, c.crop || {});
      n.animIn = Object.assign({ type: 'none', duration: 0.6 }, c.animIn || {});
      n.animOut = Object.assign({ type: 'none', duration: 0.6 }, c.animOut || {});
      if (n.type === 'text') n.text = Object.assign(defaultText(), c.text || {});
      n.effects = (Array.isArray(c.effects) ? c.effects : [])
        .filter((fx) => fx && typeof fx.type === 'string')
        .map((fx) => ({ ...fx, intensity: Math.min(1, Math.max(0.1, Number(fx.intensity) || 0.5)) }));
      return n;
    });
  out.markers = (Array.isArray(p?.markers) ? p.markers : [])
    .filter((m) => m && Number.isFinite(m.t) && m.t >= 0)
    .map((m) => ({ id: m.id || uid('mk'), t: m.t, kind: m.kind === 'beat' ? 'beat' : 'user' }))
    .sort((a, b) => a.t - b.t);
  return out;
}

export const clipEnd = (c) => c.start + c.duration;
export const isVisual = (c) => c.type === 'video' || c.type === 'image' || c.type === 'text';
export const videoTracks = (p) => p.tracks.filter((t) => t.kind === 'video');
export const audioTracks = (p) => p.tracks.filter((t) => t.kind === 'audio');
// La pista principal es la pista de video más baja: es la que admite transiciones.
export function mainTrack(p) {
  const v = videoTracks(p);
  return v[v.length - 1] || null;
}
export const trackClips = (p, trackId) => p.clips.filter((c) => c.trackId === trackId).sort((a, b) => a.start - b.start);
export const projectDuration = (p) => p.clips.reduce((m, c) => Math.max(m, clipEnd(c)), 0);

export function trackLabel(p, track) {
  const list = p.tracks.filter((t) => t.kind === track.kind);
  if (track.kind === 'video') {
    const idx = list.length - list.indexOf(track); // V1 = la de más abajo
    return `V${idx}`;
  }
  return `A${list.indexOf(track) + 1}`;
}

export function prevClipOnTrack(p, clip) {
  const list = trackClips(p, clip.trackId);
  const i = list.findIndex((c) => c.id === clip.id);
  return i > 0 ? list[i - 1] : null;
}

export function nextClipOnTrack(p, clip) {
  const list = trackClips(p, clip.trackId);
  const i = list.findIndex((c) => c.id === clip.id);
  return i >= 0 && i < list.length - 1 ? list[i + 1] : null;
}

export function clipHasAudio(clip, media) {
  if (clip.muted) return false;
  if (clip.type === 'audio') return true;
  return clip.type === 'video' && !!media && !!media.hasAudio;
}

// Duración máxima en la línea de tiempo que admite la fuente desde el punto de entrada actual.
export function maxClipDuration(clip, media) {
  if ((clip.type === 'video' || clip.type === 'audio') && media && media.duration > 0) {
    return Math.max(MIN_CLIP, (media.duration - clip.in) / (clip.speed || 1));
  }
  return Infinity;
}

export function snapToFrame(t, fps) {
  return Math.round(t * fps) / fps;
}

export function formatTime(t, fps = 30, withFrames = false) {
  if (!isFinite(t) || t < 0) t = 0;
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  const pad = (n) => String(n).padStart(2, '0');
  let out = h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
  if (withFrames) out += `:${pad(Math.floor((t % 1) * fps + 1e-6))}`;
  return out;
}

export function formatDurationShort(t) {
  if (!isFinite(t) || t <= 0) return '0:00';
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  if (m >= 60) return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}
