// Motor de reproducción de la vista previa: reloj, elementos de video/audio por clip,
// mezcla de audio con Web Audio (volumen, fundidos) y dibujo en el canvas.
import { store } from './store.js';
import { media, mediaUrl } from './media.js';
import { drawFrame } from './render.js';
import { ensureFont } from './text-render.js';
import { projectDuration, clipEnd, clipHasAudio, snapToFrame, isVisual } from '../shared/model.js';
import { mainTrackItems } from '../shared/layout.js';

const QUALITY_CAP = { high: 1920, medium: 1280, low: 854 };
// Desfase (s) a partir del cual se corrige un elemento que ya está reproduciéndose.
const RESYNC = { audio: 0.25, video: 0.45 };
// Tras corregir un elemento se espera antes de volver a hacerlo: en un equipo lento, saltar tarda.
const RESYNC_COOLDOWN = 1500;
// Lo máximo que el reloj espera a un medio que no está listo antes de seguir sin él.
const MAX_HOLD = 3000;

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
    this.holding = false;
    this.holdSince = 0;
    this.lastDraw = 0;
    this.loop = this.loop.bind(this);
    requestAnimationFrame(this.loop);
    // Abrir el dispositivo de audio tarda (más de un segundo con la CPU ocupada): se abre por adelantado y se
    // deja abierto, para que el sonido arranque al instante al reproducir.
    setTimeout(() => this.ensureAudio(), 1500);
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
    this.setHolding(false);
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
      // Si un medio que debería verse u oírse aún no está listo (está buscando o le faltan datos), el reloj
      // lo espera. Seguir adelante lo obligaba a saltar una y otra vez: el video se congelaba y el audio se cortaba.
      if (this.waitingFor(now)) {
        if (!this.holding) this.setHolding(true);
        this.t0 = this.time;
        this.p0 = now;
        this.syncEls(false);
        if (this.dirty) this.draw();
        return;
      }
      if (this.holding) {
        this.setHolding(false);
        this.t0 = this.time;
        this.p0 = now;
      }
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
      // No hace falta dibujar más veces por segundo que los fotogramas del proyecto.
      if (now - this.lastDraw >= 1000 / Math.min(60, this.fps) - 4) this.draw();
    } else if (this.dirty) {
      this.draw();
    }
  }

  setHolding(on) {
    if (this.holding === on) return;
    this.holding = on;
    this.holdSince = on ? performance.now() : 0;
    this.emit('buffering');
  }

  // Primer medio activo que todavía no puede reproducirse (o null). Tras MAX_HOLD se deja de esperarlo.
  waitingFor(now) {
    // Mientras la salida de audio no está en marcha, los elementos con sonido no avanzan: hay que esperarla.
    const audioOff = this.audioCtx && this.audioCtx.state !== 'running' && (!this.holding || now - this.holdSince < MAX_HOLD);
    for (const rec of this.els.values()) {
      if (audioOff && rec.active && rec.withAudio) return rec;
      const el = rec.el;
      const atEnd = el.ended || (el.duration > 0 && el.currentTime >= el.duration - 0.1);
      const ready = !rec.active || el.error || atEnd || (!el.seeking && !rec.stalled && el.readyState >= 2);
      if (ready) {
        rec.waitSince = 0;
        continue;
      }
      if (!rec.waitSince) rec.waitSince = now;
      if (now - rec.waitSince < MAX_HOLD) return rec;
    }
    return null;
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
      // Original o copia ligera (completa o la parte que cubre este clip); off = dónde empieza dentro del original.
      const sp = clip.speed || 1;
      const pv = media.previewFor(m, clip.in + (s - clip.start) * sp, clip.in + (e - clip.start) * sp);
      const src = mediaUrl(pv.path);
      let rec = this.els.get(clip.id);
      if (rec && (rec.src !== src || rec.withAudio !== needAudio || rec.kind !== clip.type)) {
        this.destroyEl(clip.id);
        rec = null;
      }
      if (!rec) rec = this.createEl(clip, src, needAudio);
      rec.clip = clip;
      rec.idleSince = 0;
      rec.active = active;
      const srcT = Math.max(0, Math.min((m.duration || 1e9) - 0.02, clip.in + (Math.max(t, s) - clip.start) * sp));
      const target = Math.max(0, Math.min((pv.end || 1e9) - pv.offset - 0.02, srcT - pv.offset));
      const el = rec.el;
      if (Math.abs(el.playbackRate - clip.speed) > 1e-6) {
        try {
          el.playbackRate = clip.speed;
        } catch {
          /* velocidad fuera de rango */
        }
      }
      if (this.playing && active && !this.holding) {
        if (el.paused) {
          if (!el.seeking && Math.abs(el.currentTime - target) > 0.1) this.seekEl(rec, target);
          el.play().catch(() => {});
        } else if (!el.seeking && Math.abs(el.currentTime - target) > RESYNC[rec.kind === 'audio' ? 'audio' : 'video'] && now - (rec.seekAt || 0) > RESYNC_COOLDOWN) {
          this.seekEl(rec, target);
        }
      } else {
        if (!el.paused) el.pause();
        // Durante una espera solo se pausa: reajustar unos milisegundos obligaría a buscar de nuevo (caro).
        const tol = this.holding ? 0.15 : 0.5 / this.fps;
        if (force || Math.abs(el.currentTime - target) > tol) this.seekEl(rec, target);
      }
    }
    for (const [id, rec] of this.els) {
      if (wanted.has(id)) continue;
      rec.active = false;
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
    rec.seekAt = performance.now();
    rec.el.currentTime = target;
  }

  createEl(clip, src, withAudio) {
    const el = document.createElement(clip.type === 'audio' ? 'audio' : 'video');
    el.crossOrigin = 'anonymous';
    el.preload = 'auto';
    el.playsInline = true;
    el.disableRemotePlayback = true;
    const rec = { el, src, kind: clip.type, withAudio, clip, pendingSeek: null, idleSince: 0, active: false, seekAt: 0, waitSince: 0, stalled: false };
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
    // «waiting»: se quedó sin datos mientras sonaba; vuelve a estar listo con «playing» o «canplay».
    el.addEventListener('waiting', () => {
      if (!el.paused) rec.stalled = true;
    });
    el.addEventListener('playing', () => (rec.stalled = false));
    el.addEventListener('canplay', () => (rec.stalled = false));
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

  envFor(scale, still = false) {
    this.refreshCache();
    return {
      project: store.project,
      scale,
      mainItems: this.mainItems,
      getMedia: (id) => store.getMedia(id),
      // La vista previa usa la copia decodificada (sin tirones); un fotograma guardado, la imagen original.
      getImage: (id) => (still ? media.getImage(id) : media.getDrawable(id)),
      getVideo: (clip) => {
        const r = this.els.get(clip.id);
        return r && r.el.readyState >= 2 ? r.el : null;
      },
    };
  }

  draw() {
    this.dirty = false;
    this.lastDraw = performance.now();
    drawFrame(this.ctx, this.time, this.envFor(this.scale));
    this.emit('drawn');
  }

  // Fotograma actual en resolución completa (para guardar como imagen).
  async renderStill(scale = 1) {
    return (await this.stillAt(this.time, scale)).canvas;
  }

  // Dibuja el proyecto en el instante t (mueve el cursor allí). Antes espera, como mucho timeoutMs, a que los videos
  // de ese instante terminen de buscar y a que carguen las fotos y las fuentes. Devuelve también lo que no llegó a
  // estar listo (nombres de los archivos).
  async stillAt(t, scale = 1, { timeoutMs = 8000 } = {}) {
    if (this.playing) this.pause();
    this.seek(t);
    t = this.time;
    this.refreshCache();
    const p = store.project;
    const visible = p.clips.filter((c) => {
      const info = this.baseInfo.get(c.id);
      const s = info ? info.start : c.start;
      const e = info ? info.end : clipEnd(c);
      return isVisual(c) && t >= s && t < e && !this.trackMap.get(c.trackId)?.hidden;
    });
    await Promise.all(visible.filter((c) => c.type === 'text').map((c) => ensureFont(c.text)));
    const waiting = () => {
      const out = [];
      for (const c of visible) {
        const m = c.mediaId ? store.getMedia(c.mediaId) : null;
        if (!m || m.missing) continue;
        const st = media.getStatus(m.id).state;
        if (st === 'checking' || st === 'proxy') out.push(m.name);
        else if (st === 'error') continue;
        else if (c.type === 'image' && !media.getImage(m.id)) out.push(m.name);
        else if (c.type === 'video') {
          const r = this.els.get(c.id);
          if (!r || (!r.el.error && (r.el.seeking || r.el.readyState < 2 || r.pendingSeek !== null))) out.push(m.name);
        }
      }
      return out;
    };
    const deadline = performance.now() + timeoutMs;
    let pending = waiting();
    while (pending.length && performance.now() < deadline) {
      await new Promise((r) => setTimeout(r, 60));
      this.syncEls(false);
      pending = waiting();
    }
    const c = document.createElement('canvas');
    c.width = Math.max(2, Math.round(p.settings.width * scale));
    c.height = Math.max(2, Math.round(p.settings.height * scale));
    drawFrame(c.getContext('2d'), t, this.envFor(scale, true));
    return { canvas: c, time: t, pending: [...new Set(pending)] };
  }
}
