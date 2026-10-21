// Visor: canvas de vista previa, controles de reproducción y manipulación directa
// (mover, escalar y rotar el clip seleccionado arrastrando sobre la imagen).
import { store } from './store.js';
import { h, iconBtn, $, contextMenu, toast } from './ui.js';
import { icon } from './icons.js';
import { formatTime, clipEnd, isVisual, videoTracks } from '../shared/model.js';
import { clipBox } from './render.js';
import { Player } from './player.js';

export class Viewer {
  constructor(root) {
    this.root = root;
    root.classList.add('viewer');
    this.stage = h('div', { class: 'stage' });
    this.canvas = h('canvas', { class: 'preview-canvas' });
    this.overlay = h('div', { class: 'stage-overlay' });
    this.guides = { v: h('div', { class: 'guide v' }), h: h('div', { class: 'guide h' }) };
    this.empty = h(
      'div',
      { class: 'stage-empty' },
      h('div', { class: 'stage-empty-ic', html: icon('film', 40) }),
      h('div', {}, 'Importa videos, fotos o música y arrástralos a la línea de tiempo'),
      h('div', { class: 'hint' }, 'También puedes grabar tu pantalla con el botón «Grabar»')
    );
    this.overlay.append(this.guides.v, this.guides.h);
    this.stage.append(this.canvas, this.overlay, this.empty);
    this.player = new Player(this.canvas);

    this.timeLabel = h('span', { class: 'tc' }, '00:00:00');
    this.durLabel = h('span', { class: 'tc dim' }, '00:00:00');
    this.playBtn = iconBtn('play', 'Reproducir / Pausa (Espacio)', () => this.player.toggle(), { size: 22, kind: 'play' });
    this.muteBtn = iconBtn('volume', 'Silenciar vista previa', () => {
      this.player.muted = !this.player.muted;
      this.muteBtn.innerHTML = icon(this.player.muted ? 'volumeOff' : 'volume', 18);
      this.player.updateGains();
    });
    this.qualityBtn = h('button', { class: 'btn small ghost', title: 'Calidad de la vista previa (baja = más fluida)' }, 'Media');
    this.qualityBtn.addEventListener('click', (e) => {
      const r = e.currentTarget.getBoundingClientRect();
      const set = (q, label) => {
        this.player.setQuality(q);
        this.qualityBtn.textContent = label;
        localStorage.setItem('litecut.quality', q);
      };
      contextMenu(r.left, r.bottom + 4, [
        { label: 'Alta (1080p)', onClick: () => set('high', 'Alta') },
        { label: 'Media (720p)', onClick: () => set('medium', 'Media') },
        { label: 'Baja (480p) — más fluida', onClick: () => set('low', 'Baja') },
      ]);
    });
    const q = localStorage.getItem('litecut.quality') || 'medium';
    this.player.setQuality(q);
    this.qualityBtn.textContent = { high: 'Alta', medium: 'Media', low: 'Baja' }[q] || 'Media';

    const controls = h(
      'div',
      { class: 'transport' },
      h('div', { class: 'tr-left' }, this.timeLabel, h('span', { class: 'tc dim' }, ' / '), this.durLabel),
      h(
        'div',
        { class: 'tr-center' },
        iconBtn('toStart', 'Ir al inicio (Inicio)', () => this.player.seek(0)),
        iconBtn('stepBack', 'Fotograma anterior (←)', () => this.player.step(-1)),
        this.playBtn,
        iconBtn('stepFwd', 'Fotograma siguiente (→)', () => this.player.step(1)),
        iconBtn('toEnd', 'Ir al final (Fin)', () => this.player.seek(this.player.duration))
      ),
      h(
        'div',
        { class: 'tr-right' },
        this.qualityBtn,
        this.muteBtn,
        iconBtn('snapshot', 'Guardar fotograma como imagen', () => this.onSnapshot?.()),
        iconBtn('fullscreen', 'Pantalla completa', () => this.toggleFullscreen())
      )
    );
    root.append(this.stage, controls);

    new ResizeObserver(() => this.layout()).observe(this.stage);
    this.player.addEventListener('time', () => this.updateTime());
    this.player.addEventListener('state', () => {
      this.playBtn.innerHTML = icon(this.player.playing ? 'pause' : 'play', 22);
      this.updateHandles();
    });
    this.player.addEventListener('drawn', () => this.updateHandlesThrottled());
    store.on('change', () => {
      const s = store.project.settings;
      if (`${s.width}x${s.height}` !== this.dimKey) this.layout();
      this.updateTime();
      this.updateHandles();
      this.empty.style.display = store.project.clips.length ? 'none' : '';
    });
    store.on('selection', () => this.updateHandles());
    store.on('load', () => this.layout());
    this.overlay.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    this.overlay.addEventListener('dblclick', (e) => this.onDblClick(e));
    this.layout();
  }

  layout() {
    const r = this.stage.getBoundingClientRect();
    const s = store.project.settings;
    this.dimKey = `${s.width}x${s.height}`;
    if (r.width < 10 || r.height < 10) return;
    this.player.setViewport(r.width - 16, r.height - 16);
    const cw = parseFloat(this.canvas.style.width);
    const ch = parseFloat(this.canvas.style.height);
    Object.assign(this.overlay.style, { width: `${cw}px`, height: `${ch}px` });
    this.updateHandles();
  }

  updateTime() {
    const fps = store.project.settings.fps;
    this.timeLabel.textContent = formatTime(this.player.time, fps, true);
    this.durLabel.textContent = formatTime(this.player.duration, fps, true);
  }

  toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else this.root.requestFullscreen().catch(() => {});
  }

  // ---------- Manipulación directa ----------
  get ds() {
    return this.player.displayScale || 1;
  }

  visibleClipsAt(t) {
    const p = store.project;
    const out = [];
    const tracks = videoTracks(p);
    for (let i = 0; i < tracks.length; i++) {
      const tr = tracks[i];
      if (tr.hidden) continue;
      const clips = p.clips.filter((c) => c.trackId === tr.id && isVisual(c) && t >= c.start && t < clipEnd(c));
      out.push(...clips);
    }
    return out; // de arriba hacia abajo
  }

  boxFor(clip) {
    return clipBox(clip, store.project, (id) => store.getMedia(id), this.player.scale);
  }

  hitTest(px, py) {
    for (const c of this.visibleClipsAt(this.player.time)) {
      const b = this.boxFor(c);
      if (!b) continue;
      const a = (-b.rotation * Math.PI) / 180;
      const dx = px - b.cx;
      const dy = py - b.cy;
      const lx = dx * Math.cos(a) - dy * Math.sin(a);
      const ly = dx * Math.sin(a) + dy * Math.cos(a);
      if (Math.abs(lx) <= b.w / 2 && Math.abs(ly) <= b.h / 2) return c;
    }
    return null;
  }

  updateHandlesThrottled() {
    if (this._hq) return;
    this._hq = requestAnimationFrame(() => {
      this._hq = null;
      this.updateHandles();
    });
  }

  updateHandles() {
    const clip = store.singleSelected;
    const t = this.player.time;
    const show = clip && isVisual(clip) && t >= clip.start && t < clipEnd(clip) && !this.player.playing;
    if (!show) {
      if (this.box) this.box.style.display = 'none';
      return;
    }
    const b = this.boxFor(clip);
    if (!b) return;
    if (!this.box) {
      this.box = h('div', { class: 'tbox' });
      for (const k of ['nw', 'ne', 'sw', 'se']) this.box.append(h('div', { class: `th ${k}`, dataset: { h: k } }));
      this.box.append(h('div', { class: 'th rot', dataset: { h: 'rot' }, html: icon('rotate', 12) }));
      this.overlay.append(this.box);
    }
    const s = this.ds;
    Object.assign(this.box.style, {
      display: 'block',
      left: `${(b.cx - b.w / 2) * s}px`,
      top: `${(b.cy - b.h / 2) * s}px`,
      width: `${b.w * s}px`,
      height: `${b.h * s}px`,
      transform: `rotate(${b.rotation}deg)`,
    });
  }

  toProject(e) {
    const r = this.overlay.getBoundingClientRect();
    return { x: (e.clientX - r.left) / this.ds, y: (e.clientY - r.top) / this.ds };
  }

  onDblClick(e) {
    const pt = this.toProject(e);
    const c = this.hitTest(pt.x, pt.y);
    if (c && c.type === 'text') {
      store.select([c.id]);
      setTimeout(() => {
        const ta = $('#inspector textarea');
        if (ta) {
          ta.focus();
          ta.select();
        }
      }, 50);
    }
  }

  onPointerDown(e) {
    if (e.button !== 0) return;
    if (this.player.playing) this.player.pause();
    const pt = this.toProject(e);
    const handle = e.target.closest('.th')?.dataset.h;
    let clip = store.singleSelected;
    if (!handle) {
      const hit = this.hitTest(pt.x, pt.y);
      if (!hit) {
        store.clearSelection();
        return;
      }
      if (!clip || clip.id !== hit.id) store.select([hit.id]);
      clip = hit;
    }
    if (!clip) return;
    const tr = store.getTrack(clip.trackId);
    if (tr?.locked) {
      toast('La pista está bloqueada', { timeout: 1600 });
      return;
    }
    const b = this.boxFor(clip);
    if (!b) return;
    const orig = { ...clip.transform };
    const startPt = pt;
    let moved = false;
    try {
      this.overlay.setPointerCapture(e.pointerId);
    } catch {
      /* puntero sintético o ya liberado */
    }
    const onMove = (ev) => {
      const q = this.toProject(ev);
      if (!moved && Math.hypot(q.x - startPt.x, q.y - startPt.y) * this.ds < 3) return;
      if (!moved) {
        moved = true;
        store.beginEdit();
      }
      store.live(() => {
        const T = clip.transform;
        if (!handle) {
          let nx = orig.x + (q.x - startPt.x);
          let ny = orig.y + (q.y - startPt.y);
          const snapPx = 8 / this.ds;
          const snapX = Math.abs(nx) < snapPx;
          const snapY = Math.abs(ny) < snapPx;
          if (snapX && !ev.altKey) nx = 0;
          if (snapY && !ev.altKey) ny = 0;
          this.guides.v.style.display = snapX && !ev.altKey ? 'block' : 'none';
          this.guides.h.style.display = snapY && !ev.altKey ? 'block' : 'none';
          T.x = Math.round(nx);
          T.y = Math.round(ny);
        } else if (handle === 'rot') {
          let ang = (Math.atan2(q.y - b.cy, q.x - b.cx) * 180) / Math.PI + 90;
          if (ev.shiftKey) ang = Math.round(ang / 15) * 15;
          else if (Math.abs(((ang % 90) + 90) % 90) < 3) ang = Math.round(ang / 90) * 90;
          T.rotation = Math.round(((((ang + 180) % 360) + 360) % 360) - 180);
        } else {
          const d0 = Math.hypot(startPt.x - b.cx, startPt.y - b.cy) || 1;
          const d1 = Math.hypot(q.x - b.cx, q.y - b.cy);
          T.scale = Math.max(0.05, Math.min(10, Math.round(orig.scale * (d1 / d0) * 1000) / 1000));
        }
      });
      this.updateHandles();
    };
    const onUp = () => {
      this.overlay.removeEventListener('pointermove', onMove);
      this.overlay.removeEventListener('pointerup', onUp);
      this.overlay.removeEventListener('pointercancel', onUp);
      this.guides.v.style.display = 'none';
      this.guides.h.style.display = 'none';
      if (moved) store.commitEdit();
    };
    this.overlay.addEventListener('pointermove', onMove);
    this.overlay.addEventListener('pointerup', onUp);
    this.overlay.addEventListener('pointercancel', onUp);
  }
}
