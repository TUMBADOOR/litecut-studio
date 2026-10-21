// Gestión de medios: importación, comprobación de compatibilidad, proxies, miniaturas y formas de onda.
import { store } from './store.js';
import { uid, mediaKindFromPath, baseName } from '../shared/model.js';
import { toast } from './ui.js';

const api = window.api;
export const mediaUrl = (p) => api.mediaUrl(p);

// Códecs de audio que Chromium reproduce; con otros se crea un proxy para la vista previa.
const PLAYABLE_AUDIO = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac', 'pcm_s16le', 'pcm_s24le', 'pcm_s32le', 'pcm_f32le', 'pcm_u8', 'mp3float']);

class MediaManager extends EventTarget {
  constructor() {
    super();
    this.thumbs = new Map();
    this.peaks = new Map();
    this.images = new Map();
    this.status = new Map();
    this.prefs = { proxy4k: true };
    api.media.onProxyProgress(({ id, progress }) => this.setStatus(id, { state: 'proxy', progress }));
  }

  emitChange(id) {
    this.dispatchEvent(new CustomEvent('change', { detail: { id } }));
  }

  setStatus(id, s) {
    this.status.set(id, { ...(this.status.get(id) || {}), ...s });
    this.emitChange(id);
  }

  getStatus(id) {
    return this.status.get(id) || { state: 'ready' };
  }

  previewPath(m) {
    return m.proxyPath || m.path;
  }

  async importPaths(paths) {
    const added = [];
    for (const p of paths) {
      if (!p) continue;
      const kind = mediaKindFromPath(p);
      if (!kind) {
        toast(`Formato no compatible: ${baseName(p)}`, { type: 'error' });
        continue;
      }
      const existing = store.project.media.find((m) => m.path === p);
      if (existing) {
        added.push(existing);
        continue;
      }
      const r = await api.media.probe(p);
      if (!r.ok) {
        toast(`No se pudo abrir «${baseName(p)}»: ${r.error.message}`, { type: 'error', timeout: 7000 });
        continue;
      }
      const info = r.info;
      let k = kind;
      if (kind === 'video' && !info.hasVideo && info.hasAudio) k = 'audio';
      if (k === 'audio' && !info.hasAudio) {
        toast(`«${baseName(p)}» no tiene audio`, { type: 'error' });
        continue;
      }
      if ((k === 'video' || k === 'image') && !(info.width > 0)) {
        toast(`No se pudo leer el tamaño de «${baseName(p)}»`, { type: 'error' });
        continue;
      }
      const m = {
        id: uid('med'),
        path: p,
        name: baseName(p),
        kind: k,
        duration: k === 'image' ? 0 : info.duration,
        width: info.width,
        height: info.height,
        hasAudio: k !== 'image' && info.hasAudio,
        hasVideo: info.hasVideo,
        fps: info.fps,
        size: info.size,
        start: info.start || 0,
        container: info.container,
        vcodec: info.vcodec,
        acodec: info.acodec,
      };
      store.addMedia(m);
      added.push(m);
      this.setStatus(m.id, { state: 'checking' });
      this.enqueuePrepare(m);
    }
    return added;
  }

  // Prepara los medios de uno en uno (en equipos modestos, varios a la vez saturan el disco y la CPU).
  enqueuePrepare(m) {
    this.prepQueue = (this.prepQueue || Promise.resolve()).then(() => this.prepare(m)).catch(() => {});
    return this.prepQueue;
  }

  needsProxyByCodec(m) {
    if (m.hasAudio && m.acodec && !PLAYABLE_AUDIO.has(m.acodec)) return true;
    if (m.kind === 'video' && this.prefs.proxy4k && Math.max(m.width, m.height) > 2600) return true;
    return false;
  }

  async prepare(m) {
    this.setStatus(m.id, { state: 'checking', error: null });
    try {
      const exists = await api.fs.exists([m.path, m.proxyPath]);
      if (!exists[0]) {
        store.updateMedia(m.id, { missing: true });
        this.setStatus(m.id, { state: 'missing' });
        return;
      }
      if (m.missing) store.updateMedia(m.id, { missing: false });
      if (m.proxyPath && !exists[1]) store.updateMedia(m.id, { proxyPath: null });
      if (!m.proxyPath) {
        const playable = !this.needsProxyByCodec(m) && (await this.canPlay(m));
        if (!playable) {
          this.setStatus(m.id, { state: 'proxy', progress: 0 });
          const r = await api.media.proxy({ id: m.id, file: m.path, kind: m.kind, duration: m.duration, hasAudio: m.hasAudio });
          if (!r.ok) throw new Error(r.error.message);
          store.updateMedia(m.id, { proxyPath: r.path });
        }
      }
      this.setStatus(m.id, { state: 'ready', progress: 1 });
      if (m.kind === 'image') this.loadImage(m);
      if (m.kind === 'video') this.loadThumbs(m);
      if (m.hasAudio) this.loadPeaks(m);
    } catch (err) {
      this.setStatus(m.id, { state: 'error', error: err.message });
      toast(`«${m.name}»: ${err.message}`, { type: 'error', timeout: 7000 });
    }
  }

  canPlay(m) {
    return new Promise((resolve) => {
      if (m.kind === 'image') {
        const img = new Image();
        img.onload = () => resolve(true);
        img.onerror = () => resolve(false);
        img.src = mediaUrl(m.path);
        return;
      }
      const el = document.createElement(m.kind === 'audio' ? 'audio' : 'video');
      let done = false;
      const finish = (ok) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        el.removeAttribute('src');
        el.load();
        resolve(ok);
      };
      const timer = setTimeout(() => finish(false), 12000);
      el.muted = true;
      el.preload = 'auto';
      el.crossOrigin = 'anonymous';
      el.addEventListener('loadeddata', () => finish(m.kind === 'audio' || el.videoWidth > 0));
      el.addEventListener('error', () => finish(false));
      el.src = mediaUrl(m.path);
    });
  }

  loadImage(m) {
    const src = mediaUrl(this.previewPath(m));
    const cur = this.images.get(m.id);
    if (cur && cur.dataset.src === src) return cur;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.dataset.src = src;
    img.onload = () => this.emitChange(m.id);
    img.src = src;
    this.images.set(m.id, img);
    return img;
  }

  getImage(mediaId) {
    const img = this.images.get(mediaId);
    if (img) return img.complete && img.naturalWidth > 0 ? img : null;
    const m = store.getMedia(mediaId);
    if (m && m.kind === 'image') this.loadImage(m);
    return null;
  }

  async loadThumbs(m) {
    if (this.thumbs.has(m.id)) return;
    this.thumbs.set(m.id, []);
    const list = await api.media.thumbs(m.path, m.duration);
    const arr = list.map((t) => {
      const img = new Image();
      img.onload = () => this.emitChange(m.id);
      img.src = mediaUrl(t.file);
      return { t: t.t, img };
    });
    this.thumbs.set(m.id, arr);
    this.emitChange(m.id);
  }

  // Miniatura más cercana al instante t de la fuente.
  thumbAt(mediaId, t) {
    const arr = this.thumbs.get(mediaId);
    if (!arr || !arr.length) return null;
    let lo = 0;
    let hi = arr.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid].t < t) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0 && Math.abs(arr[lo - 1].t - t) < Math.abs(arr[lo].t - t)) lo--;
    const img = arr[lo].img;
    return img.complete && img.naturalWidth > 0 ? img : null;
  }

  poster(m) {
    if (m.kind === 'image') return this.getImage(m.id);
    if (m.kind === 'video') return this.thumbAt(m.id, Math.min(1, m.duration * 0.1)) || this.thumbAt(m.id, 0);
    return null;
  }

  async loadPeaks(m) {
    if (this.peaks.has(m.id)) return;
    this.peaks.set(m.id, null);
    const r = await api.media.peaks(m.path);
    this.peaks.set(m.id, r && r.data && r.data.length ? { perSec: r.perSec, data: r.data } : null);
    this.emitChange(m.id);
  }

  getPeaks(mediaId) {
    return this.peaks.get(mediaId) || null;
  }

  forget(mediaId) {
    this.thumbs.delete(mediaId);
    this.peaks.delete(mediaId);
    this.images.delete(mediaId);
    this.status.delete(mediaId);
  }

  // Volver a enlazar un archivo movido o renombrado.
  async relink(m, newPath) {
    const r = await api.media.probe(newPath);
    if (!r.ok) {
      toast(`No se pudo abrir el archivo: ${r.error.message}`, { type: 'error' });
      return false;
    }
    this.forget(m.id);
    store.updateMedia(m.id, {
      path: newPath,
      name: baseName(newPath),
      missing: false,
      proxyPath: null,
      duration: m.kind === 'image' ? 0 : r.info.duration,
      width: r.info.width || m.width,
      height: r.info.height || m.height,
      start: r.info.start || 0,
      container: r.info.container,
      vcodec: r.info.vcodec,
      acodec: r.info.acodec,
    });
    store.setDirty(true);
    await this.prepare(store.getMedia(m.id));
    return true;
  }

  async prepareAll() {
    const list = store.project.media;
    if (!list.length) return;
    // Primero marca los archivos que faltan (rápido), luego prepara el resto en cola.
    const exists = await api.fs.exists(list.map((m) => m.path));
    list.forEach((m, i) => {
      if (!exists[i]) {
        store.updateMedia(m.id, { missing: true });
        this.setStatus(m.id, { state: 'missing' });
      } else {
        this.setStatus(m.id, { state: 'checking' });
        this.enqueuePrepare(m);
      }
    });
  }
}

export const media = new MediaManager();
