// Línea de tiempo: pistas, clips, regla, cursor, recorte, arrastre, imán, zoom y transiciones.
import { store } from './store.js';
import { media } from './media.js';
import * as edit from './edit.js';
import { dnd } from './dnd.js';
import { h, iconBtn, contextMenu, rafThrottle, modKey, confirmDialog, toast } from './ui.js';
import { icon } from './icons.js';
import { clipEnd, mainTrack, trackLabel, MIN_CLIP, formatTime, snapToFrame, isVisual, trackClips, projectDuration } from '../shared/model.js';
import { TRANSITIONS } from '../shared/effects.js';
import * as ops from '../shared/ops.js';

const RULER_H = 26;
const ZONE_H = 14;
const LANE_H = { main: 62, video: 50, audio: 44 };
const MIN_PPS = 2;
const MAX_PPS = 600;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const fps = () => store.project.settings.fps || 30;

function laneHeight(track, isMain) {
  if (track.kind === 'audio') return LANE_H.audio;
  return isMain ? LANE_H.main : LANE_H.video;
}

// Etiquetas de la regla: mm:ss, o con décimas / fotogramas cuando hay mucho zoom.
function rulerLabel(t, major, f) {
  if (major >= 1) return formatTime(t, f);
  const whole = Math.floor(t + 1e-6);
  if (major >= 0.5) return `${formatTime(whole, f)}.${Math.round((t - whole) * 10)}`;
  return `${formatTime(whole, f)} f${Math.round((t - whole) * f)}`;
}

function drawCover(ctx, img, x, y, w, hgt) {
  const iw = img.naturalWidth || img.width;
  const ih = img.naturalHeight || img.height;
  if (!iw || !ih) return;
  const s = Math.max(w / iw, hgt / ih);
  const sw = w / s;
  const sh = hgt / s;
  ctx.drawImage(img, (iw - sw) / 2, (ih - sh) / 2, sw, sh, x, y, w, hgt);
}

export class Timeline {
  constructor(root, viewer) {
    this.root = root;
    this.viewer = viewer;
    this.player = viewer.player;
    this.pps = 40;
    this.snap = localStorage.getItem('litecut.snap') !== '0';
    this.clipEls = new Map();
    this.laneEls = new Map();
    this.zoneEls = [];
    this.transEls = [];
    this.trackSig = '';
    this.schedulePaint = rafThrottle(() => this.paintVisible());
    this.scheduleRuler = rafThrottle(() => this.paintRuler());
    this.scheduleRender = rafThrottle(() => this.render());
    this.build();
    store.on('change', () => this.render());
    store.on('selection', () => this.renderSelection());
    store.on('load', () => requestAnimationFrame(() => this.fitZoom()));
    this.player.addEventListener('time', () => this.onTime());
    media.addEventListener('change', () => this.scheduleRender());
    new ResizeObserver(() => {
      this.updateWidth();
      this.scheduleRuler();
      this.schedulePaint();
    }).observe(this.scroll);
    this.render();
  }

  // ---------- Construcción ----------
  build() {
    const r = this.root;
    r.classList.add('timeline');
    this.undoBtn = iconBtn('undo', `Deshacer (${modKey}+Z)`, () => store.undo());
    this.redoBtn = iconBtn('redo', `Rehacer (${modKey}+Y)`, () => store.redo());
    this.snapBtn = iconBtn('magnet', 'Imán: ajusta a bordes de clips y al cursor (N)', () => this.toggleSnap(), { active: this.snap });
    this.zoomRange = h('input', { type: 'range', min: 0, max: 1000, class: 'zoom-range', title: 'Zoom de la línea de tiempo' });
    this.zoomRange.addEventListener('input', () => this.setZoom(this.sliderToPps(+this.zoomRange.value)));
    this.selInfo = h('div', { class: 'sel-info' });
    const toolbar = h(
      'div',
      { class: 'tl-toolbar' },
      h('div', { class: 'grp' }, this.undoBtn, this.redoBtn),
      h('div', { class: 'vsep' }),
      h(
        'div',
        { class: 'grp' },
        iconBtn('scissors', 'Dividir en el cursor (S)', () => edit.splitAtPlayhead()),
        iconBtn('trash', 'Eliminar (Supr)', () => edit.deleteSelected(false)),
        iconBtn('copy', `Duplicar (${modKey}+D)`, () => edit.duplicateSelected()),
        iconBtn('detach', 'Separar el audio del video', () => edit.detachAudioSelected()),
        iconBtn('freeze', 'Congelar fotograma (2 s)', () => edit.freezeFrameSelected()),
        iconBtn('gap', 'Cerrar huecos de la pista principal', () => edit.closeGapsMain())
      ),
      h('div', { class: 'vsep' }),
      this.snapBtn,
      h('div', { class: 'spacer' }),
      this.selInfo,
      h(
        'div',
        { class: 'grp zoom' },
        iconBtn('zoomOut', 'Alejar (−)', () => this.zoomBy(1 / 1.5)),
        this.zoomRange,
        iconBtn('zoomIn', 'Acercar (+)', () => this.zoomBy(1.5)),
        iconBtn('fit', 'Ajustar a la ventana (Mayús+Z)', () => this.fitZoom())
      )
    );

    this.heads = h('div', { class: 'tl-heads' });
    this.headsWrap = h('div', { class: 'tl-heads-wrap' }, this.heads);
    const addBtn = h('button', { class: 'btn small ghost add-track', type: 'button', title: 'Añadir pista' });
    addBtn.innerHTML = `${icon('plus', 14)}<span>Pista</span>`;
    addBtn.addEventListener('click', () => {
      const rr = addBtn.getBoundingClientRect();
      contextMenu(rr.left, rr.bottom + 4, [
        { label: 'Pista de video / texto', icon: 'film', onClick: () => edit.addTrack('video') },
        { label: 'Pista de audio', icon: 'music', onClick: () => edit.addTrack('audio') },
      ]);
    });
    const corner = h('div', { class: 'tl-corner', style: { height: `${RULER_H}px` } }, addBtn);
    const side = h('div', { class: 'tl-side' }, corner, this.headsWrap);

    this.ruler = h('canvas', { class: 'tl-ruler' });
    this.lanes = h('div', { class: 'tl-lanes' });
    this.phCap = h('div', { class: 'tl-ph-cap' });
    this.playhead = h('div', { class: 'tl-playhead' }, this.phCap);
    this.snapLine = h('div', { class: 'tl-snapline' });
    this.marquee = h('div', { class: 'tl-marquee' });
    this.dropGhost = h('div', { class: 'tl-dropghost' });
    this.content = h('div', { class: 'tl-content' }, this.ruler, this.lanes, this.playhead, this.snapLine, this.marquee, this.dropGhost);
    this.scroll = h('div', { class: 'tl-scroll' }, this.content);
    this.tip = h('div', { class: 'tl-tip' });
    r.append(toolbar, h('div', { class: 'tl-main' }, side, this.scroll), this.tip);

    this.scroll.addEventListener('scroll', () => {
      this.headsWrap.scrollTop = this.scroll.scrollTop;
      this.scheduleRuler();
      this.schedulePaint();
    });
    this.scroll.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    this.headsWrap.addEventListener('wheel', (e) => {
      this.scroll.scrollTop += e.deltaY;
    }, { passive: true });
    this.ruler.addEventListener('pointerdown', (e) => this.onRulerDown(e));
    this.phCap.addEventListener('pointerdown', (e) => this.onRulerDown(e));
    this.lanes.addEventListener('pointerdown', (e) => this.onLanesDown(e));
    this.lanes.addEventListener('contextmenu', (e) => this.onContextMenu(e));
    this.lanes.addEventListener('dblclick', (e) => this.onDblClick(e));
    this.lanes.addEventListener('dragover', (e) => this.onDragOver(e));
    this.lanes.addEventListener('dragleave', (e) => {
      if (!this.lanes.contains(e.relatedTarget)) this.hideDropGhost();
    });
    this.lanes.addEventListener('drop', (e) => this.onDrop(e));
    this.heads.addEventListener('contextmenu', (e) => this.onHeadMenu(e));
  }

  buildTracks() {
    const p = store.project;
    const main = mainTrack(p);
    this.heads.innerHTML = '';
    this.lanes.innerHTML = '';
    this.laneEls.clear();
    this.zoneEls = [];
    this.transEls = [];
    const zone = (kind) => {
      const z = h('div', { class: `tl-zone ${kind}`, dataset: { zone: kind }, style: { height: `${ZONE_H}px` } }, kind === 'video' ? 'Suelta aquí para crear una pista de video' : 'Suelta aquí para crear una pista de audio');
      this.zoneEls.push(z);
      this.lanes.append(z);
      this.heads.append(h('div', { class: 'tl-head-spacer', style: { height: `${ZONE_H}px` } }));
    };
    zone('video');
    let audioStarted = false;
    for (const t of p.tracks) {
      if (t.kind === 'audio' && !audioStarted) {
        audioStarted = true;
        this.lanes.append(h('div', { class: 'tl-divider' }));
        this.heads.append(h('div', { class: 'tl-divider' }));
      }
      const isMain = main && t.id === main.id;
      const H = laneHeight(t, isMain);
      const lane = h('div', { class: `tl-lane k-${t.kind}${isMain ? ' main' : ''}${t.locked ? ' locked' : ''}${t.hidden ? ' hidden-track' : ''}`, dataset: { track: t.id }, style: { height: `${H}px` } });
      this.laneEls.set(t.id, lane);
      this.lanes.append(lane);
      const btns = h('div', { class: 'th-btns' });
      if (t.kind === 'video') btns.append(iconBtn(t.hidden ? 'eyeOff' : 'eye', t.hidden ? 'Mostrar pista' : 'Ocultar pista', () => edit.setTrackFlag(t.id, 'hidden'), { size: 15, kind: t.hidden ? 'warn' : '' }));
      btns.append(iconBtn(t.muted ? 'volumeOff' : 'volume', t.muted ? 'Activar sonido' : 'Silenciar pista', () => edit.setTrackFlag(t.id, 'muted'), { size: 15, kind: t.muted ? 'warn' : '' }));
      btns.append(iconBtn(t.locked ? 'lock' : 'unlock', t.locked ? 'Desbloquear pista' : 'Bloquear pista', () => edit.setTrackFlag(t.id, 'locked'), { size: 15, kind: t.locked ? 'warn' : '' }));
      const head = h(
        'div',
        { class: `tl-head k-${t.kind}${isMain ? ' main' : ''}`, dataset: { track: t.id }, style: { height: `${H}px` } },
        h('div', { class: 'th-name' }, h('span', { class: 'th-ic', html: icon(t.kind === 'audio' ? 'music' : isMain ? 'film' : 'layers', 13) }), h('b', {}, trackLabel(p, t)), isMain ? h('span', { class: 'th-badge' }, 'Principal') : null),
        btns
      );
      this.heads.append(head);
    }
    zone('audio');
  }

  // ---------- Renderizado ----------
  render() {
    const p = store.project;
    const main = mainTrack(p);
    const sig = p.tracks.map((t) => `${t.id}${t.kind}${t.hidden ? 1 : 0}${t.muted ? 1 : 0}${t.locked ? 1 : 0}`).join('|') + (main?.id || '');
    if (sig !== this.trackSig) {
      this.buildTracks();
      this.trackSig = sig;
    }
    this.updateWidth();
    const seen = new Set();
    for (const c of p.clips) {
      const lane = this.laneEls.get(c.trackId);
      if (!lane) continue;
      let el = this.clipEls.get(c.id);
      if (!el) {
        el = this.createClipEl(c);
        this.clipEls.set(c.id, el);
      }
      if (el.parentNode !== lane) lane.append(el);
      this.updateClipEl(el, c);
      seen.add(c.id);
    }
    for (const [id, el] of this.clipEls)
      if (!seen.has(id)) {
        el.remove();
        this.clipEls.delete(id);
      }
    this.renderTransitions(main);
    this.renderSelection();
    this.updateButtons();
    this.onTime();
    this.scheduleRuler();
    this.schedulePaint();
  }

  updateWidth() {
    const d = projectDuration(store.project);
    const vw = this.scroll.clientWidth || 800;
    const w = Math.max(vw + 200, (d + 30) * this.pps);
    this.content.style.width = `${Math.round(w)}px`;
  }

  createClipEl(c) {
    const el = h(
      'div',
      { class: `clip t-${c.type}`, dataset: { id: c.id } },
      h('canvas', { class: 'clip-cv' }),
      h('div', { class: 'clip-top' }, h('span', { class: 'clip-ic' }), h('span', { class: 'clip-name' }), h('span', { class: 'clip-badges' })),
      h('div', { class: 'clip-h l', title: 'Arrastra para recortar el inicio' }),
      h('div', { class: 'clip-h r', title: 'Arrastra para recortar el final' })
    );
    el._cv = el.querySelector('.clip-cv');
    el._ic = el.querySelector('.clip-ic');
    el._name = el.querySelector('.clip-name');
    el._badges = el.querySelector('.clip-badges');
    return el;
  }

  updateClipEl(el, c) {
    el.style.left = `${c.start * this.pps}px`;
    el.style.width = `${Math.max(3, c.duration * this.pps)}px`;
    el.style.transform = '';
    const m = c.mediaId ? store.getMedia(c.mediaId) : null;
    const st = m ? media.getStatus(m.id) : null;
    const name = c.type === 'text' ? (c.text?.content || 'Texto').split('\n')[0] : c.name || m?.name || '';
    const badges = [];
    if (Math.abs((c.speed || 1) - 1) > 1e-3) badges.push(`<i class="bdg">${+c.speed.toFixed(2)}×</i>`);
    if (c.type === 'video' && m?.hasAudio && c.muted) badges.push(icon('volumeOff', 11));
    if (c.type === 'audio' && c.linkedTo) badges.push(`<i class="bdg" title="Sigue a su video">${icon('link', 10)}</i>`);
    if (c.filter && c.filter !== 'none') badges.push(icon('sparkles', 11));
    if ((c.animIn?.type || 'none') !== 'none' || (c.animOut?.type || 'none') !== 'none' || (c.kenburns || 'none') !== 'none') badges.push(icon('wand', 11));
    if (m?.missing) badges.push(`<i class="bdg err">Sin archivo</i>`);
    else if (st?.state === 'proxy') badges.push(`<i class="bdg">Preparando ${Math.round((st.progress || 0) * 100)}%</i>`);
    const typeIcon = { video: 'film', image: 'image', audio: 'music', text: 'text' }[c.type];
    const sig = `${name}|${badges.join('')}|${typeIcon}`;
    if (el._sig !== sig) {
      el._sig = sig;
      el._ic.innerHTML = icon(typeIcon, 11);
      el._name.textContent = name;
      el._badges.innerHTML = badges.join('');
      el.title = `${name}\nInicio ${formatTime(c.start, fps(), true)} · Duración ${c.duration.toFixed(2)} s`;
    }
    el.classList.toggle('missing', !!m?.missing);
    const tr = store.getTrack(c.trackId);
    el.classList.toggle('locked', !!tr?.locked);
    el.classList.toggle('narrow', c.duration * this.pps < 40);
  }

  renderTransitions(main) {
    for (const el of this.transEls) el.remove();
    this.transEls = [];
    if (!main) return;
    const lane = this.laneEls.get(main.id);
    if (!lane) return;
    const list = trackClips(store.project, main.id).filter(isVisual);
    for (let i = 1; i < list.length; i++) {
      const a = list[i - 1];
      const b = list[i];
      if (b.transitionIn) {
        const ov = clipEnd(a) - b.start;
        const name = TRANSITIONS.find((x) => x.id === b.transitionIn.type)?.name || 'Transición';
        const el = h('div', { class: 'trans', dataset: { clip: b.id }, title: `${name} (${ov.toFixed(2)} s) — clic para editar` });
        el.innerHTML = icon('transition', 14);
        el.style.left = `${b.start * this.pps}px`;
        el.style.width = `${Math.max(16, ov * this.pps)}px`;
        lane.append(el);
        this.transEls.push(el);
      } else if (Math.abs(b.start - clipEnd(a)) < 0.02) {
        const el = h('button', { class: 'junc', type: 'button', dataset: { clip: b.id }, title: 'Añadir transición' });
        el.innerHTML = icon('plus', 11);
        el.style.left = `${b.start * this.pps}px`;
        lane.append(el);
        this.transEls.push(el);
      }
    }
  }

  renderSelection() {
    for (const [id, el] of this.clipEls) el.classList.toggle('selected', store.selection.has(id));
    for (const el of this.transEls) el.classList.toggle('selected', el.dataset.clip === store.selectedTransition);
    const sel = store.selectedClips;
    if (sel.length > 1) this.selInfo.textContent = `${sel.length} clips seleccionados`;
    else if (sel.length === 1) this.selInfo.textContent = `Duración ${sel[0].duration.toFixed(2)} s`;
    else this.selInfo.textContent = '';
  }

  updateButtons() {
    this.undoBtn.disabled = !store.canUndo;
    this.redoBtn.disabled = !store.canRedo;
  }

  onTime() {
    const x = this.player.time * this.pps;
    this.playhead.style.transform = `translateX(${x}px)`;
    if (this.player.playing) {
      const vl = this.scroll.scrollLeft;
      const vw = this.scroll.clientWidth;
      if (x > vl + vw - 40 || x < vl) this.scroll.scrollLeft = Math.max(0, x - 80);
    }
  }

  // ---------- Pintado de miniaturas y ondas ----------
  paintVisible() {
    const vl = this.scroll.scrollLeft;
    const vr = vl + this.scroll.clientWidth;
    for (const [id, el] of this.clipEls) {
      const c = store.getClip(id);
      if (!c) continue;
      const x0 = c.start * this.pps;
      const x1 = x0 + c.duration * this.pps;
      if (x1 < vl - 80 || x0 > vr + 80) {
        if (el._cv.style.display !== 'none') el._cv.style.display = 'none';
        el._paintSig = null;
        continue;
      }
      this.paintClip(el, c, vl, vr);
    }
  }

  paintClip(el, c, vl, vr) {
    const cv = el._cv;
    if (c.type === 'text') {
      cv.style.display = 'none';
      return;
    }
    const x0 = c.start * this.pps;
    const w = c.duration * this.pps;
    const visL = Math.max(0, Math.floor(vl - 80 - x0));
    const visR = Math.min(w, Math.ceil(vr + 80 - x0));
    if (visR <= visL) {
      cv.style.display = 'none';
      return;
    }
    const hgt = el.clientHeight || 40;
    const m = c.mediaId ? store.getMedia(c.mediaId) : null;
    if (!m) return;
    const nThumbs = media.thumbs.get(m.id)?.length || 0;
    const hasPeaks = !!media.getPeaks(m.id);
    const imgOk = c.type === 'image' ? !!media.getImage(m.id) : true;
    const sig = [visL, visR, hgt, this.pps, c.in, c.speed, c.duration, nThumbs, hasPeaks, imgOk, c.volume, c.muted, c.fadeIn, c.fadeOut].join('|');
    if (el._paintSig === sig) return;
    el._paintSig = sig;
    const dpr = window.devicePixelRatio || 1;
    const cw = visR - visL;
    cv.style.display = 'block';
    cv.style.left = `${visL}px`;
    cv.style.width = `${cw}px`;
    cv.style.height = `${hgt}px`;
    cv.width = Math.max(1, Math.round(cw * dpr));
    cv.height = Math.max(1, Math.round(hgt * dpr));
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, hgt);
    if (c.type === 'video' || c.type === 'image') {
      const aspect = m.width && m.height ? m.width / m.height : 16 / 9;
      const tw = Math.max(28, hgt * aspect);
      const first = Math.floor(visL / tw);
      for (let i = first; i * tw < visR; i++) {
        const x = i * tw - visL;
        let img = null;
        if (c.type === 'image') img = media.getImage(m.id);
        else img = media.thumbAt(m.id, c.in + ((i * tw + tw / 2) / this.pps) * c.speed);
        if (img) {
          ctx.save();
          ctx.beginPath();
          ctx.rect(x, 0, tw, hgt);
          ctx.clip();
          drawCover(ctx, img, x, 0, tw, hgt);
          ctx.restore();
        }
      }
      if (c.type === 'video' && m.hasAudio && !c.muted && hasPeaks) {
        ctx.fillStyle = 'rgba(0,0,0,.45)';
        ctx.fillRect(0, hgt - 13, cw, 13);
        this.paintWave(ctx, c, m, visL, cw, hgt - 12, 11, 'rgba(160,255,240,.85)', false);
      }
    } else if (c.type === 'audio') {
      this.paintWave(ctx, c, m, visL, cw, 14, hgt - 16, 'rgba(190,255,225,.9)', true);
    }
  }

  paintWave(ctx, c, m, visL, cw, y, hgt, color, centered) {
    const pk = media.getPeaks(m.id);
    if (!pk) return;
    const { perSec, data } = pk;
    const vol = Math.min(2, c.volume ?? 1);
    const D = c.duration;
    ctx.fillStyle = color;
    for (let px = 0; px < cw; px++) {
      const tl0 = (visL + px) / this.pps;
      const tl1 = (visL + px + 1) / this.pps;
      const i0 = Math.max(0, Math.floor((c.in + tl0 * c.speed) * perSec));
      const i1 = Math.max(i0 + 1, Math.ceil((c.in + tl1 * c.speed) * perSec));
      let mx = 0;
      for (let i = i0; i < i1 && i < data.length; i++) if (data[i] > mx) mx = data[i];
      let env = 1;
      if (c.fadeIn > 0) env *= Math.min(1, tl0 / c.fadeIn);
      if (c.fadeOut > 0) env *= Math.min(1, (D - tl0) / c.fadeOut);
      const amp = Math.min(1, (mx / 255) * vol * 1.15) * Math.max(0, env);
      const bh = Math.max(1, amp * hgt);
      ctx.fillRect(px, centered ? y + (hgt - bh) / 2 : y + hgt - bh, 1, bh);
    }
  }

  paintRuler() {
    const c = this.ruler;
    const vw = this.scroll.clientWidth;
    if (!vw) return;
    const dpr = window.devicePixelRatio || 1;
    if (c.width !== Math.round(vw * dpr) || c.height !== Math.round(RULER_H * dpr)) {
      c.width = Math.round(vw * dpr);
      c.height = Math.round(RULER_H * dpr);
      c.style.width = `${vw}px`;
      c.style.height = `${RULER_H}px`;
    }
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#17171c';
    ctx.fillRect(0, 0, vw, RULER_H);
    const x0 = this.scroll.scrollLeft;
    const pps = this.pps;
    const f = fps();
    const steps = [1 / f, 2 / f, 5 / f, 10 / f, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
    let major = steps[steps.length - 1];
    for (const s of steps) {
      if (s * pps >= 84) {
        major = s;
        break;
      }
    }
    const div = major * pps / 5 >= 8 ? 5 : 2;
    const minor = major / div;
    const first = Math.floor(x0 / pps / minor);
    ctx.font = '10px system-ui, sans-serif';
    ctx.textBaseline = 'top';
    for (let i = first; ; i++) {
      const t = i * minor;
      const x = Math.round(t * pps - x0) + 0.5;
      if (x > vw) break;
      const isMajor = i % div === 0;
      ctx.fillStyle = isMajor ? '#6c6c7a' : '#3c3c46';
      ctx.fillRect(x, isMajor ? RULER_H - 11 : RULER_H - 6, 1, isMajor ? 11 : 6);
      if (isMajor && t >= 0) {
        ctx.fillStyle = '#a3a3b2';
        ctx.fillText(rulerLabel(t, major, f), x + 4, 4);
      }
    }
    ctx.fillStyle = '#2a2a33';
    ctx.fillRect(0, RULER_H - 1, vw, 1);
  }

  // ---------- Zoom ----------
  ppsToSlider(pps) {
    return Math.round((Math.log(pps / MIN_PPS) / Math.log(MAX_PPS / MIN_PPS)) * 1000);
  }

  sliderToPps(v) {
    return MIN_PPS * Math.pow(MAX_PPS / MIN_PPS, v / 1000);
  }

  setZoom(pps, { anchorTime, anchorX } = {}) {
    pps = clamp(pps, MIN_PPS, MAX_PPS);
    const vw = this.scroll.clientWidth || 800;
    if (anchorTime === undefined) {
      anchorTime = this.player.time;
      anchorX = anchorTime * this.pps - this.scroll.scrollLeft;
      if (anchorX < 0 || anchorX > vw) {
        anchorX = vw / 2;
        anchorTime = (this.scroll.scrollLeft + anchorX) / this.pps;
      }
    }
    this.pps = pps;
    this.zoomRange.value = this.ppsToSlider(pps);
    this.render();
    this.scroll.scrollLeft = Math.max(0, anchorTime * pps - anchorX);
  }

  zoomBy(f) {
    this.setZoom(this.pps * f);
  }

  fitZoom() {
    const d = Math.max(5, projectDuration(store.project));
    const vw = this.scroll.clientWidth || 800;
    this.setZoom((vw - 60) / d, { anchorTime: 0, anchorX: 0 });
  }

  toggleSnap() {
    this.snap = !this.snap;
    localStorage.setItem('litecut.snap', this.snap ? '1' : '0');
    this.snapBtn.classList.toggle('active', this.snap);
    toast(this.snap ? 'Imán activado' : 'Imán desactivado', { timeout: 1200 });
  }

  // ---------- Utilidades de posición ----------
  timeAt(clientX) {
    const r = this.scroll.getBoundingClientRect();
    return (clientX - r.left + this.scroll.scrollLeft) / this.pps;
  }

  laneAt(clientY) {
    for (const [id, el] of this.laneEls) {
      const r = el.getBoundingClientRect();
      if (clientY >= r.top && clientY < r.bottom) return { trackId: id, el };
    }
    for (const z of this.zoneEls) {
      const r = z.getBoundingClientRect();
      if (clientY >= r.top - 6 && clientY < r.bottom + 6) return { zone: z.dataset.zone, el: z };
    }
    return null;
  }

  snapTargets(excludeIds, withPlayhead = true) {
    const out = [0];
    if (withPlayhead) out.push(this.player.time);
    for (const c of store.project.clips) {
      if (excludeIds && excludeIds.has(c.id)) continue;
      out.push(c.start, clipEnd(c));
    }
    return out;
  }

  // Devuelve el tiempo ajustado (o null si no hay imán cercano).
  findSnap(times, targets, thr) {
    let best = null;
    for (const t of times)
      for (const x of targets) {
        const d = Math.abs(x - t);
        if (d < thr && (!best || d < best.d)) best = { d, delta: x - t, at: x };
      }
    return best;
  }

  showSnapLine(t) {
    if (t === null || t === undefined) {
      this.snapLine.style.display = 'none';
      return;
    }
    this.snapLine.style.display = 'block';
    this.snapLine.style.transform = `translateX(${t * this.pps}px)`;
  }

  showTip(text, clientX, clientY) {
    if (!text) {
      this.tip.style.display = 'none';
      return;
    }
    this.tip.textContent = text;
    this.tip.style.display = 'block';
    const r = this.root.getBoundingClientRect();
    this.tip.style.left = `${clientX - r.left + 12}px`;
    this.tip.style.top = `${clientY - r.top - 30}px`;
  }

  // ---------- Interacción ----------
  onWheel(e) {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const r = this.scroll.getBoundingClientRect();
      const ax = e.clientX - r.left;
      const at = (this.scroll.scrollLeft + ax) / this.pps;
      this.setZoom(this.pps * (e.deltaY < 0 ? 1.2 : 1 / 1.2), { anchorTime: at, anchorX: ax });
    } else if (e.shiftKey) {
      e.preventDefault();
      this.scroll.scrollLeft += e.deltaY || e.deltaX;
    }
  }

  onRulerDown(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    if (this.player.playing) this.player.pause();
    const target = e.currentTarget;
    const seek = (ev) => {
      let t = Math.max(0, this.timeAt(ev.clientX));
      if (this.snap && !ev.altKey) {
        const s = this.findSnap([t], this.snapTargets(null, false), 6 / this.pps);
        if (s) t = s.at;
      }
      this.player.seek(snapToFrame(t, fps()));
    };
    seek(e);
    try {
      target.setPointerCapture(e.pointerId);
    } catch {
      /* puntero sintético o ya liberado */
    }
    const move = (ev) => seek(ev);
    const up = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      target.removeEventListener('pointercancel', up);
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
    target.addEventListener('pointercancel', up);
  }

  onLanesDown(e) {
    if (e.button !== 0) return;
    const junc = e.target.closest('.junc');
    if (junc) {
      e.stopPropagation();
      edit.applyTransition(junc.dataset.clip, 'fade', 0.6);
      return;
    }
    const trans = e.target.closest('.trans');
    if (trans) {
      store.selectTransition(trans.dataset.clip);
      return;
    }
    const clipEl = e.target.closest('.clip');
    if (clipEl) {
      const clip = store.getClip(clipEl.dataset.id);
      if (!clip) return;
      const additive = e.ctrlKey || e.metaKey || e.shiftKey;
      if (e.ctrlKey || e.metaKey) store.select([clip.id], { toggle: true });
      else if (e.shiftKey) store.select([clip.id], { add: true });
      else if (!store.selection.has(clip.id)) store.select([clip.id]);
      const tr = store.getTrack(clip.trackId);
      if (tr?.locked) return;
      const handle = e.target.closest('.clip-h');
      if (handle && !additive) this.startTrim(e, clip, handle.classList.contains('l') ? 'l' : 'r');
      else if (store.selection.has(clip.id)) this.startMove(e, clip, additive);
      return;
    }
    this.startMarquee(e);
  }

  startMove(e, clip, additive) {
    const moving = store.selectedClips.filter((c) => !store.getTrack(c.trackId)?.locked);
    if (!moving.some((c) => c.id === clip.id)) moving.push(clip);
    const ids = new Set(moving.map((c) => c.id));
    const orig = new Map(moving.map((c) => [c.id, { start: c.start, trackId: c.trackId }]));
    const single = moving.length === 1;
    const x0 = e.clientX;
    const y0 = e.clientY;
    const targets = this.snapTargets(ids);
    const minStart = Math.min(...moving.map((c) => c.start));
    const origLane = this.laneEls.get(clip.trackId);
    let dragging = false;
    let delta = 0;
    let target = { trackId: clip.trackId };
    const kindOk = (trackId) => {
      const tr = store.getTrack(trackId);
      return tr && !tr.locked && (tr.kind === 'audio') === (clip.type === 'audio');
    };
    const onMove = (ev) => {
      if (!dragging && Math.abs(ev.clientX - x0) + Math.abs(ev.clientY - y0) < 5) return;
      if (!dragging) {
        dragging = true;
        document.body.classList.add('tl-dragging');
        if (this.player.playing) this.player.pause();
      }
      let dt = (ev.clientX - x0) / this.pps;
      dt = Math.max(dt, -minStart);
      let snapAt = null;
      if (this.snap && !ev.altKey) {
        const a = orig.get(clip.id).start + dt;
        const s = this.findSnap([a, a + clip.duration], targets, 8 / this.pps);
        if (s) {
          dt += s.delta;
          snapAt = s.at;
        }
      }
      delta = Math.max(dt, -minStart);
      this.showSnapLine(snapAt);
      if (single) {
        const lane = this.laneAt(ev.clientY);
        if (lane?.trackId && kindOk(lane.trackId)) target = { trackId: lane.trackId };
        else if (lane?.zone && (lane.zone === 'audio') === (clip.type === 'audio')) target = { zone: lane.zone };
        else if (!lane) target = { trackId: clip.trackId };
        for (const z of this.zoneEls) z.classList.toggle('hot', target.zone === z.dataset.zone);
      }
      for (const c of moving) {
        const el = this.clipEls.get(c.id);
        if (!el) continue;
        el.style.left = `${(orig.get(c.id).start + delta) * this.pps}px`;
        el.classList.add('dragging');
        if (single && el === this.clipEls.get(clip.id)) {
          const tEl = target.trackId ? this.laneEls.get(target.trackId) : this.zoneEls.find((z) => z.dataset.zone === target.zone);
          const dy = tEl && origLane ? tEl.getBoundingClientRect().top - origLane.getBoundingClientRect().top : 0;
          el.style.transform = `translateY(${dy}px)`;
        }
      }
      this.showTip(formatTime(orig.get(clip.id).start + delta, fps(), true), ev.clientX, ev.clientY);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.body.classList.remove('tl-dragging');
      this.showSnapLine(null);
      this.showTip(null);
      for (const z of this.zoneEls) z.classList.remove('hot');
      for (const c of moving) this.clipEls.get(c.id)?.classList.remove('dragging');
      if (!dragging) {
        if (!additive) store.select([clip.id]);
        return;
      }
      const moves = moving.map((c) => ({
        id: c.id,
        start: Math.max(0, snapToFrame(orig.get(c.id).start + delta, fps())),
        trackId: single && target.trackId ? target.trackId : c.trackId,
      }));
      store.mutate((p) => {
        if (single && target.zone) moves[0].trackId = ops.addTrack(p, target.zone).id;
        ops.moveClips(p, moves);
      });
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  startTrim(e, clip, side) {
    e.stopPropagation();
    const p = store.project;
    const m = clip.mediaId ? store.getMedia(clip.mediaId) : null;
    const list = trackClips(p, clip.trackId);
    const idx = list.findIndex((c) => c.id === clip.id);
    const prev = list[idx - 1];
    const next = list[idx + 1];
    const o = { start: clip.start, duration: clip.duration, in: clip.in, end: clipEnd(clip) };
    const hasSource = (clip.type === 'video' || clip.type === 'audio') && m?.duration > 0;
    const sp = clip.speed || 1;
    const maxEnd = Math.min(hasSource ? o.start + (m.duration - o.in) / sp : Infinity, next ? Math.max(o.end, next.start) : Infinity);
    const minStart = Math.max(0, prev ? Math.min(o.start, clipEnd(prev)) : 0, hasSource ? o.start - o.in / sp : -Infinity);
    const targets = this.snapTargets(new Set([clip.id]));
    const x0 = e.clientX;
    let started = false;
    const onMove = (ev) => {
      const dt = (ev.clientX - x0) / this.pps;
      if (!started) {
        if (Math.abs(ev.clientX - x0) < 2) return;
        started = true;
        store.beginEdit();
        document.body.classList.add('tl-trimming');
      }
      let snapAt = null;
      store.live(() => {
        const c = store.getClip(clip.id);
        if (c.type === 'audio') c.linkedTo = null; // recortar el audio por separado lo desvincula
        if (side === 'r') {
          let end = o.end + dt;
          if (this.snap && !ev.altKey) {
            const s = this.findSnap([end], targets, 8 / this.pps);
            if (s) {
              end = s.at;
              snapAt = s.at;
            }
          }
          end = clamp(end, o.start + MIN_CLIP, maxEnd);
          c.duration = snapToFrame(end, fps()) - c.start;
          if (c.duration < MIN_CLIP) c.duration = MIN_CLIP;
        } else {
          let st = o.start + dt;
          if (this.snap && !ev.altKey) {
            const s = this.findSnap([st], targets, 8 / this.pps);
            if (s) {
              st = s.at;
              snapAt = s.at;
            }
          }
          st = snapToFrame(clamp(st, minStart, o.end - MIN_CLIP), fps());
          c.start = st;
          c.duration = o.end - st;
          if (hasSource) c.in = Math.max(0, o.in + (st - o.start) * sp);
        }
      });
      this.showSnapLine(snapAt);
      const c = store.getClip(clip.id);
      this.showTip(`Duración ${c.duration.toFixed(2)} s`, ev.clientX, ev.clientY);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.body.classList.remove('tl-trimming');
      this.showSnapLine(null);
      this.showTip(null);
      if (started) store.commitEdit();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  startMarquee(e) {
    const additive = e.ctrlKey || e.metaKey || e.shiftKey;
    const base = additive ? new Set(store.selection) : new Set();
    if (!additive) store.clearSelection();
    if (this.player.playing) this.player.pause();
    this.player.seek(snapToFrame(Math.max(0, this.timeAt(e.clientX)), fps()));
    const cr = this.content.getBoundingClientRect();
    const sx = e.clientX - cr.left;
    const sy = e.clientY - cr.top;
    let active = false;
    const onMove = (ev) => {
      const r = this.content.getBoundingClientRect();
      const x = ev.clientX - r.left;
      const y = ev.clientY - r.top;
      if (!active && Math.abs(x - sx) + Math.abs(y - sy) < 6) return;
      active = true;
      const L = Math.min(x, sx);
      const T = Math.min(y, sy);
      Object.assign(this.marquee.style, { display: 'block', left: `${L}px`, top: `${T}px`, width: `${Math.abs(x - sx)}px`, height: `${Math.abs(y - sy)}px` });
      const mr = this.marquee.getBoundingClientRect();
      const ids = new Set(base);
      for (const [id, el] of this.clipEls) {
        const br = el.getBoundingClientRect();
        if (br.right > mr.left && br.left < mr.right && br.bottom > mr.top && br.top < mr.bottom) ids.add(id);
      }
      store.select([...ids]);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      this.marquee.style.display = 'none';
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  onDblClick(e) {
    const clipEl = e.target.closest('.clip');
    if (!clipEl) return;
    const clip = store.getClip(clipEl.dataset.id);
    if (!clip) return;
    store.select([clip.id]);
    if (clip.type === 'text') {
      const t = Math.max(clip.start, Math.min(clipEnd(clip) - 0.01, this.timeAt(e.clientX)));
      this.player.seek(t);
      setTimeout(() => {
        const ta = document.querySelector('#inspector textarea');
        if (ta) {
          ta.focus();
          ta.select();
        }
      }, 60);
    }
  }

  onContextMenu(e) {
    e.preventDefault();
    const trans = e.target.closest('.trans');
    if (trans) {
      store.selectTransition(trans.dataset.clip);
      contextMenu(e.clientX, e.clientY, [{ label: 'Quitar transición', icon: 'trash', danger: true, onClick: () => edit.removeTransition(trans.dataset.clip) }]);
      return;
    }
    const clipEl = e.target.closest('.clip');
    const t = Math.max(0, this.timeAt(e.clientX));
    if (!clipEl) {
      const lane = this.laneAt(e.clientY);
      contextMenu(e.clientX, e.clientY, [
        {
          label: 'Pegar aquí',
          icon: 'copy',
          shortcut: `${modKey}+V`,
          disabled: !store.clipboard?.length,
          onClick: () => {
            this.player.seek(t);
            edit.paste();
          },
        },
        { label: 'Añadir texto aquí', icon: 'text', onClick: () => edit.addText('title', { start: t, trackId: lane?.trackId }) },
        'sep',
        { label: 'Cerrar huecos de la pista principal', icon: 'gap', onClick: () => edit.closeGapsMain() },
      ]);
      return;
    }
    const clip = store.getClip(clipEl.dataset.id);
    if (!clip) return;
    if (!store.selection.has(clip.id)) store.select([clip.id]);
    const m = clip.mediaId ? store.getMedia(clip.mediaId) : null;
    const main = mainTrack(store.project);
    const onMain = main && clip.trackId === main.id && isVisual(clip);
    const hasPrev = onMain && trackClips(store.project, main.id).some((c) => c.id !== clip.id && isVisual(c) && c.start < clip.start);
    contextMenu(e.clientX, e.clientY, [
      { label: 'Dividir en el cursor', icon: 'scissors', shortcut: 'S', onClick: () => edit.splitAtPlayhead() },
      { label: 'Copiar', icon: 'copy', shortcut: `${modKey}+C`, onClick: () => edit.copySelected() },
      { label: 'Duplicar', icon: 'copy', shortcut: `${modKey}+D`, onClick: () => edit.duplicateSelected() },
      'sep',
      clip.type === 'video' && m?.hasAudio
        ? clip.muted
          ? { label: 'Devolver el audio al video', icon: 'volume', onClick: () => edit.reattachAudio(clip.id) }
          : { label: 'Separar audio', icon: 'detach', onClick: () => edit.detachAudioSelected() }
        : null,
      clip.type === 'video' ? { label: 'Congelar fotograma', icon: 'freeze', onClick: () => edit.freezeFrameSelected() } : null,
      hasPrev
        ? clip.transitionIn
          ? { label: 'Quitar transición de entrada', icon: 'transition', onClick: () => edit.removeTransition(clip.id) }
          : { label: 'Añadir transición de entrada', icon: 'transition', onClick: () => edit.applyTransition(clip.id, 'fade', 0.6) }
        : null,
      m ? { label: 'Mostrar archivo en la carpeta', icon: 'folder', onClick: () => window.api.shell.showItem(m.path) } : null,
      'sep',
      { label: 'Eliminar', icon: 'trash', shortcut: 'Supr', danger: true, onClick: () => edit.deleteSelected(false) },
      { label: 'Eliminar y cerrar hueco', icon: 'trash', shortcut: 'Mayús+Supr', danger: true, onClick: () => edit.deleteSelected(true) },
    ]);
  }

  onHeadMenu(e) {
    const head = e.target.closest('.tl-head');
    if (!head) return;
    e.preventDefault();
    const id = head.dataset.track;
    const tr = store.getTrack(id);
    if (!tr) return;
    const count = store.project.clips.filter((c) => c.trackId === id).length;
    contextMenu(e.clientX, e.clientY, [
      { label: 'Añadir pista de video', icon: 'film', onClick: () => edit.addTrack('video') },
      { label: 'Añadir pista de audio', icon: 'music', onClick: () => edit.addTrack('audio') },
      'sep',
      {
        label: 'Eliminar pista',
        icon: 'trash',
        danger: true,
        onClick: async () => {
          if (count && !(await confirmDialog({ title: 'Eliminar pista', message: `La pista tiene ${count} clip(s). ¿Eliminarla con su contenido?`, ok: 'Eliminar', danger: true }))) return;
          edit.removeTrack(id);
        },
      },
    ]);
  }

  // ---------- Soltar desde los paneles ----------
  onDragOver(e) {
    const pl = dnd.payload;
    if (!pl) {
      if (e.dataTransfer.types.includes('Files')) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }
      return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    const t = Math.max(0, this.timeAt(e.clientX));
    const lane = this.laneAt(e.clientY);
    for (const z of this.zoneEls) z.classList.toggle('hot', lane?.zone === z.dataset.zone);
    const g = this.dropGhost;
    const cr = this.content.getBoundingClientRect();
    if (pl.type === 'transition') {
      const b = ops.junctionNear(store.project, t);
      const main = mainTrack(store.project);
      const laneEl = main && this.laneEls.get(main.id);
      if (!b || !laneEl) return this.hideDropGhost();
      const lr = laneEl.getBoundingClientRect();
      Object.assign(g.style, { display: 'block', left: `${b.start * this.pps - 10}px`, width: '20px', top: `${lr.top - cr.top}px`, height: `${lr.height}px` });
      g.className = 'tl-dropghost junction';
      return;
    }
    if (pl.type === 'filter') {
      const el = document.elementFromPoint(e.clientX, e.clientY)?.closest('.clip');
      for (const ce of this.clipEls.values()) ce.classList.toggle('drop-target', ce === el);
      return this.hideDropGhost(true);
    }
    const laneEl = lane?.el;
    if (!laneEl) return this.hideDropGhost();
    const lr = laneEl.getBoundingClientRect();
    const dur = pl.duration || 3;
    Object.assign(g.style, { display: 'block', left: `${t * this.pps}px`, width: `${Math.max(6, dur * this.pps)}px`, top: `${lr.top - cr.top + 2}px`, height: `${Math.max(10, lr.height - 4)}px` });
    g.className = 'tl-dropghost';
  }

  hideDropGhost(keepTargets = false) {
    this.dropGhost.style.display = 'none';
    for (const z of this.zoneEls) z.classList.remove('hot');
    if (!keepTargets) for (const ce of this.clipEls.values()) ce.classList.remove('drop-target');
  }

  onDrop(e) {
    const pl = dnd.payload;
    this.hideDropGhost();
    const t = snapToFrame(Math.max(0, this.timeAt(e.clientX)), fps());
    const lane = this.laneAt(e.clientY);
    if (!pl) {
      const files = [...(e.dataTransfer.files || [])].map((f) => window.api.getPathForFile(f)).filter(Boolean);
      if (files.length) {
        e.preventDefault();
        e.stopPropagation();
        this.onFilesDropped?.(files, { start: t, trackId: lane?.trackId || null });
      }
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    dnd.payload = null;
    document.body.classList.remove('dnd-active');
    switch (pl.type) {
      case 'media': {
        const m = store.getMedia(pl.id);
        if (!m) return;
        let trackId = null;
        let newTrack = null;
        let start = t;
        if (this.snap) {
          const s = this.findSnap([t], this.snapTargets(null), 10 / this.pps);
          if (s) start = s.at;
        }
        if (lane?.trackId) {
          const tr = store.getTrack(lane.trackId);
          if (tr && (tr.kind === 'audio') === (m.kind === 'audio')) trackId = tr.id;
        } else if (lane?.zone) newTrack = lane.zone;
        edit.addMediaClip(m.id, { trackId, start, newTrack });
        break;
      }
      case 'text':
        edit.addText(pl.id, { start: t, trackId: lane?.trackId || null });
        break;
      case 'sticker':
        edit.addSticker(pl.emoji, { start: t, trackId: lane?.trackId || null });
        break;
      case 'transition': {
        const b = ops.junctionNear(store.project, t);
        if (b) edit.applyTransition(b.id, pl.id, b.transitionIn?.duration || 0.6);
        else toast('Las transiciones van entre dos clips de la pista principal', { timeout: 2500 });
        break;
      }
      case 'filter': {
        const el = document.elementFromPoint(e.clientX, e.clientY)?.closest('.clip');
        if (el) edit.applyFilterPreset([el.dataset.id], pl.id);
        break;
      }
      default:
        break;
    }
  }
}
