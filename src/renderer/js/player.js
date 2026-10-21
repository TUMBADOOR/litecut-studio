// Motor de reproducción de la vista previa: reloj, elementos de video/audio por clip,
// mezcla de audio con Web Audio (volumen, fundidos) y dibujo en el canvas.
import { store } from './store.js';
import { media, mediaUrl } from './media.js';
import { drawFrame } from './render.js';
import { projectDuration, clipEnd, clipHasAudio, snapToFrame } from '../shared/model.js';
import { mainTrackItems } from '../shared/layout.js';

const QUALITY_CAP = { high: 1920, medium: 1280, low: 854 };

export class Player extends EventTarget {
  constructor(canvas) {
    super();
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.time = 0;
    this.playing = false;
    this.els = new Map();
    this.dirty = true;
    this.scale = 0.5;
    this.quality = 'medium';
    this.audioCtx = null;
    this.master = null;
    this.muted = false;
    this.volume = 1;
    this.cacheVersion = -1;
    this.mainItems = [];
    this.loop = this.loop.bind(this);
    requestAnimationFrame(this.loop);
    store.on('change', () => {
      this.dirty = true;
      if (this.time > this.duration) this.time = this.duration;
      this.syncEls(true);
    });
    store.on('load', () => {
      for (const id of [...this.els.keys()]) this.destroyEl(id);
      this.time = 0;
      this.emit('time');
    });
    media.addEventListener('change', () => {
      this.dirty = true;
      // Un medio que termina de prepararse necesita su elemento de video/audio.
      if (!this.playing) this.syncEls(false);
    });
    window.addEventListener('litecut:fonts', () => {
      this.dirty = true;
    });
  }

  emit(type) {
    this.dispatchEvent(new Event(type));
  }

  get duration() {
    return projectDuration(store.project);
  }

  get fps() {
    return store.project.settings.fps || 30;
  }

  refreshCache() {
    if (this.cacheVersion === store.version) return;
    const p = store.project;
    this.cacheVersion = store.version;
    this.mediaClips = p.clips.filter((c) => c.type === 'video' || c.type === 'audio');
    this.mainItems = mainTrackItems(p);
    this.baseInfo = new Map(this.mainItems.map((it) => [it.clip.id, it]));
    this.trackMap = new Map(p.tracks.map((t) => [t.id, t]));
  }

  ensureAudio() {
    if (!this.audioCtx) {
      this.audioCtx = new AudioContext({ latencyHint: 'playback' });
      this.master = this.audioCtx.createGain();
      this.master.connect(this.audioCtx.destination);
    }
    if (this.audioCtx.state === 'suspended') this.audioCtx.resume();
    return this.audioCtx;
  }

  play() {
    if (this.playing) return;
    const d = this.duration;
    if (d <= 0) return;
    if (this.time >= d - 0.5 / this.fps) this.time = 0;
    this.ensureAudio();
    this.playing = true;
    this.t0 = this.time;
    this.p0 = performance.now();
    this.syncEls(true);
    this.emit('state');
  }

  pause() {
    if (!this.playing) return;
    this.playing = false;
    for (const r of this.els.values()) {
      if (!r.el.paused) r.el.pause();
      if (r.gain) r.gain.gain.value = 0;
    }
    this.time = snapToFrame(this.time, this.fps);
    this.dirty = true;
    this.syncEls(true);
    this.emit('state');
    this.emit('time');
  }

  toggle() {
    if (this.playing) this.pause();
    else this.play();
  }

  seek(t) {
    t = Math.max(0, Math.min(t, Math.max(0, this.duration)));
    this.time = t;
    if (this.playing) {
      this.t0 = t;
      this.p0 = performance.now();
    }
    this.dirty = true;
    this.syncEls(true);
    this.emit('time');
  }

  step(frames) {
    if (this.playing) this.pause();
    this.seek(snapToFrame(this.time + frames / this.fps, this.fps));
  }

  setQuality(q) {
    this.quality = QUALITY_CAP[q] ? q : 'medium';
    if (this.viewport) this.setViewport(this.viewport.w, this.viewport.h);
  }

  // Ajusta la resolución interna del canvas al espacio disponible (y a la calidad elegida).
  setViewport(cssW, cssH) {
    this.viewport = { w: cssW, h: cssH };
    const p = store.project;
    const PW = p.settings.width;
    const PH = p.settings.height;
    const fit = Math.max(0.01, Math.min(cssW / PW, cssH / PH));
    const dpr = window.devicePixelRatio || 1;
    const cap = QUALITY_CAP[this.quality] / Math.max(PW, PH);
    const scale = Math.min(fit * dpr, cap, 1);
    const w = Math.max(2, Math.round(PW * scale));
    const h = Math.max(2, Math.round(PH * scale));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.canvas.style.width = `${Math.round(PW * fit)}px`;
    this.canvas.style.height = `${Math.round(PH * fit)}px`;
    this.scale = w / PW;
    this.displayScale = fit;
    this.dirty = true;
  }

  loop(now) {
    requestAnimationFrame(this.loop);
    if (this.playing) {
      const d = this.duration;
      let t = this.t0 + (now - this.p0) / 1000;
      if (t >= d) {
        this.time = d;
        this.pause();
        this.draw();
        return;
      }
      this.time = t;
      this.emit('time');
      this.syncEls(false);
      this.updateGains();
      this.draw();
    } else if (this.dirty) {
      this.draw();
    }
  }

  syncEls(force) {
    this.refreshCache();
    const t = this.time;
    const now = performance.now();
    const wanted = new Set();
    for (const clip of this.mediaClips) {
      const tr = this.trackMap.get(clip.trackId);
      if (!tr) continue;
      const m = store.getMedia(clip.mediaId);
      if (!m || m.missing) continue;
      const st = media.getStatus(m.id).state;
      if (st === 'proxy' || st === 'checking' || st === 'missing') continue;
      const needVideo = clip.type === 'video' && !tr.hidden;
      const needAudio = clipHasAudio(clip, m) && !tr.muted;
      if (!needVideo && !needAudio) continue;
      const info = this.baseInfo.get(clip.id);
      const s = info ? info.start : clip.start;
      const e = info ? info.end : clipEnd(clip);
      const active = t >= s && t < e;
      const preload = this.playing && t >= s - 1.5 && t < s;
      if (!active && !preload) continue;
      wanted.add(clip.id);
      const src = mediaUrl(media.previewPath(m));
      let rec = this.els.get(clip.id);
      if (rec && (rec.src !== src || rec.withAudio !== needAudio || rec.kind !== clip.type)) {
        this.destroyEl(clip.id);
        rec = null;
      }
      if (!rec) rec = this.createEl(clip, src, needAudio);
      rec.clip = clip;
      rec.idleSince = 0;
      const target = Math.max(0, Math.min((m.duration || 1e9) - 0.02, clip.in + (Math.max(t, s) - clip.start) * clip.speed));
      const el = rec.el;
      if (Math.abs(el.playbackRate - clip.speed) > 1e-6) {
        try {
          el.playbackRate = clip.speed;
        } catch {
          /* velocidad fuera de rango */
        }
      }
      if (this.playing && active) {
        if (el.paused) {
          if (Math.abs(el.currentTime - target) > 0.04) el.currentTime = target;
          el.play().catch(() => {});
        } else if (Math.abs(el.currentTime - target) > 0.3) {
          el.currentTime = target;
        }
      } else {
        if (!el.paused) el.pause();
        if (force || Math.abs(el.currentTime - target) > 0.5 / this.fps) this.seekEl(rec, target);
      }
    }
    for (const [id, rec] of this.els) {
      if (wanted.has(id)) continue;
      if (!rec.el.paused) rec.el.pause();
      if (rec.gain) rec.gain.gain.value = 0;
      if (!rec.idleSince) rec.idleSince = now;
      else if (now - rec.idleSince > 6000) this.destroyEl(id);
    }
  }

  seekEl(rec, target) {
    if (rec.el.seeking) {
      rec.pendingSeek = target;
      return;
    }
    if (Math.abs(rec.el.currentTime - target) < 0.0005 && rec.el.readyState >= 2) return;
    rec.el.currentTime = target;
  }

  createEl(clip, src, withAudio) {
    const el = document.createElement(clip.type === 'audio' ? 'audio' : 'video');
    el.crossOrigin = 'anonymous';
    el.preload = 'auto';
    el.playsInline = true;
    el.disableRemotePlayback = true;
    const rec = { el, src, kind: clip.type, withAudio, clip, pendingSeek: null, idleSince: 0 };
    el.addEventListener('seeked', () => {
      this.dirty = true;
      if (rec.pendingSeek !== null) {
        const t = rec.pendingSeek;
        rec.pendingSeek = null;
        this.seekEl(rec, t);
      }
    });
    el.addEventListener('loadeddata', () => {
      this.dirty = true;
    });
    if (withAudio) {
      const ac = this.ensureAudio();
      rec.source = ac.createMediaElementSource(el);
      rec.gain = ac.createGain();
      rec.gain.gain.value = 0;
      rec.source.connect(rec.gain).connect(this.master);
    } else {
      el.muted = true;
    }
    el.src = src;
    this.els.set(clip.id, rec);
    return rec;
  }

  destroyEl(id) {
    const rec = this.els.get(id);
    if (!rec) return;
    rec.el.pause();
    try {
      rec.source?.disconnect();
      rec.gain?.disconnect();
    } catch {
      /* ya desconectado */
    }
    rec.el.removeAttribute('src');
    rec.el.load();
    this.els.delete(id);
  }

  updateGains() {
    const ac = this.audioCtx;
    if (!ac) return;
    const t = this.time;
    for (const rec of this.els.values()) {
      if (!rec.gain) continue;
      const clip = rec.clip;
      const info = this.baseInfo.get(clip.id);
      const s = info ? info.start : clip.start;
      const e = info ? info.end : clipEnd(clip);
      let g = 0;
      if (this.playing && t >= s && t < e) {
        const local = t - s;
        const D = e - s;
        g = clip.volume ?? 1;
        if (clip.fadeIn > 0) g *= Math.min(1, local / clip.fadeIn);
        if (clip.fadeOut > 0) g *= Math.min(1, (D - local) / clip.fadeOut);
        if (info?.head) g *= Math.min(1, local / info.head);
        if (info?.tail) g *= Math.min(1, (D - local) / info.tail);
      }
      rec.gain.gain.setTargetAtTime(Math.max(0, g), ac.currentTime, 0.012);
    }
    this.master.gain.value = this.muted ? 0 : this.volume;
  }

  envFor(scale) {
    this.refreshCache();
    return {
      project: store.project,
      scale,
      mainItems: this.mainItems,
      getMedia: (id) => store.getMedia(id),
      getImage: (id) => media.getImage(id),
      getVideo: (clip) => {
        const r = this.els.get(clip.id);
        return r && r.el.readyState >= 2 ? r.el : null;
      },
    };
  }

  draw() {
    this.dirty = false;
    drawFrame(this.ctx, this.time, this.envFor(this.scale));
    this.emit('drawn');
  }

  // Fotograma actual en resolución completa (para guardar como imagen).
  async renderStill(scale = 1) {
    if (this.playing) this.pause();
    this.syncEls(true);
    await new Promise((r) => setTimeout(r, 150));
    const p = store.project;
    const c = document.createElement('canvas');
    c.width = Math.round(p.settings.width * scale);
    c.height = Math.round(p.settings.height * scale);
    drawFrame(c.getContext('2d'), this.time, this.envFor(scale));
    return c;
  }
}
