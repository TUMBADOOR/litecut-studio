// Gestión de medios: importación, comprobación de compatibilidad, proxies, miniaturas y formas de onda.
import { store } from './store.js';
import { uid, mediaKindFromPath, baseName } from '../shared/model.js';
import { toast } from './ui.js';
import { heavyReason } from './device.js';

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
    this.bitmaps = new Map();
    this.status = new Map();
    this.optimizing = new Set();
    this.prefs = { autoOptimize: localStorage.getItem('litecut.autoOptimize') !== '0' };
    api.media.onProxyProgress(({ id, progress }) => this.setStatus(id, this.optimizing.has(id) ? { progress } : { state: 'proxy', progress }));
  }

  setAutoOptimize(on) {
    this.prefs.autoOptimize = !!on;
    localStorage.setItem('litecut.autoOptimize', on ? '1' : '0');
    if (on) for (const m of store.project.media) if (m.kind === 'video' && !m.proxyPath && this.getStatus(m.id).state === 'ready') this.maybeOptimize(m);
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
    return !!(m.hasAudio && m.acodec && !PLAYABLE_AUDIO.has(m.acodec));
  }

  // Videos que este equipo no reproduce con soltura (p. ej. AV1 sin decodificación por hardware o 4K en un
  // equipo modesto): mientras se sigue editando con el original, se crea en segundo plano una copia ligera
  // (720p H.264) solo para la vista previa. La exportación siempre usa el archivo original.
  async maybeOptimize(m) {
    if (!this.prefs.autoOptimize || m.proxyPath || this.optimizing.has(m.id)) return;
    const reason = await heavyReason(m).catch(() => null);
    if (!reason || this.optimizing.has(m.id)) return;
    this.optimizing.add(m.id);
    this.setStatus(m.id, { optimizing: true, progress: 0 });
    if (!this.optimizeHinted) {
      this.optimizeHinted = true;
      toast(`«${m.name}» (${reason}) es pesado para este equipo: se está creando una copia ligera para editar con fluidez. Al exportar se usa el original.`, { timeout: 9000 });
    }
    try {
      const r = await api.media.proxy({ id: m.id, file: m.path, kind: 'video', duration: m.duration, hasAudio: m.hasAudio });
      const cur = store.getMedia(m.id);
      if (r.ok && cur && cur.path === m.path && !cur.proxyPath) store.updateMedia(m.id, { proxyPath: r.path });
    } finally {
      this.optimizing.delete(m.id);
      this.setStatus(m.id, { optimizing: false });
    }
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
      if (m.kind === 'video') this.maybeOptimize(store.getMedia(m.id) || m);
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
    img.onload = () => {
      this.emitChange(m.id);
      this.makeBitmap(m.id, src);
    };
    img.src = src;
    this.images.set(m.id, img);
    this.bitmaps.get(m.id)?.bitmap?.close();
    this.bitmaps.delete(m.id);
    return img;
  }

  getImage(mediaId) {
    const img = this.images.get(mediaId);
    if (img) return img.complete && img.naturalWidth > 0 ? img : null;
    const m = store.getMedia(mediaId);
    if (m && m.kind === 'image') this.loadImage(m);
    return null;
  }

  // Imagen ya decodificada (fuera del hilo de la interfaz) para dibujarla en los lienzos sin tirones:
  // dibujar por primera vez una foto grande sin decodificar congela la app más de un segundo en equipos modestos.
  getDrawable(mediaId) {
    const b = this.bitmaps.get(mediaId);
    if (b) return b.bitmap || (b.failed ? this.getImage(mediaId) : null);
    const img = this.getImage(mediaId);
    if (img) this.makeBitmap(mediaId, img.dataset.src);
    return null;
  }

  makeBitmap(id, src) {
    if (this.bitmaps.get(id)?.src === src) return;
    const entry = { src, bitmap: null };
    this.bitmaps.set(id, entry);
    const m = store.getMedia(id);
    // Para la vista previa bastan 1280 px de lado mayor: ahorra memoria y subirla a la gráfica es más rápido.
    const k = m && m.width && m.height ? Math.min(1, 1280 / Math.max(m.width, m.height)) : 1;
    const opts = k < 1 ? { resizeWidth: Math.round(m.width * k), resizeHeight: Math.round(m.height * k), resizeQuality: 'high' } : {};
    fetch(src)
      .then((r) => r.blob())
      .then((blob) => createImageBitmap(blob, opts))
      .then((bitmap) => {
        if (this.bitmaps.get(id) !== entry) return bitmap.close();
        entry.bitmap = bitmap;
        this.emitChange(id);
      })
      .catch(() => {
        // Sin copia decodificada se dibuja la imagen normal (como antes).
        entry.failed = true;
        this.emitChange(id);
      });
  }

  async loadThumbs(m) {
    if (this.thumbs.has(m.id)) return;
    this.thumbs.set(m.id, []);
    const list = await api.media.thumbs(m.path, m.duration, { vcodec: m.vcodec });
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

  // Igual que poster() pero listo para dibujar en un canvas.
  posterDrawable(m) {
    return m.kind === 'image' ? this.getDrawable(m.id) : this.poster(m);
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
    this.bitmaps.get(mediaId)?.bitmap?.close();
    this.bitmaps.delete(mediaId);
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
