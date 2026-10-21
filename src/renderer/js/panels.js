// Paneles de la izquierda: Medios, Audio, Texto, Stickers, Transiciones, Filtros y Grabar.
import { store } from './store.js';
import { media } from './media.js';
import * as edit from './edit.js';
import { makeDraggable } from './dnd.js';
import { h, btn, segmented, contextMenu, confirmDialog, toast, fmtBytes, clear } from './ui.js';
import { icon } from './icons.js';
import { formatDurationShort, defaultAdjust, defaultText } from '../shared/model.js';
import { TRANSITIONS, FILTER_PRESETS } from '../shared/effects.js';
import { TEXT_PRESETS, STICKERS, renderTextCanvas, ensureFont } from './text-render.js';
import { cssFilterFor } from './render.js';

const TABS = [
  { id: 'media', label: 'Medios', icon: 'folder' },
  { id: 'audio', label: 'Audio', icon: 'music' },
  { id: 'text', label: 'Texto', icon: 'text' },
  { id: 'stickers', label: 'Stickers', icon: 'smile' },
  { id: 'transitions', label: 'Transic.', icon: 'transition' },
  { id: 'filters', label: 'Filtros', icon: 'sparkles' },
  { id: 'record', label: 'Grabar', icon: 'record' },
];

export class Panels {
  constructor(tabsRoot, panelRoot, actions) {
    this.tabsRoot = tabsRoot;
    this.root = panelRoot;
    this.actions = actions;
    this.tab = localStorage.getItem('litecut.tab') || 'media';
    this.filter = 'all';
    this.previewAudio = null;
    for (const t of TABS) {
      const b = h('button', { class: `stab${t.id === 'record' ? ' rec' : ''}`, type: 'button', dataset: { tab: t.id }, title: t.label });
      b.innerHTML = `${icon(t.icon, 20)}<span>${t.label}</span>`;
      b.addEventListener('click', () => this.show(t.id));
      tabsRoot.append(b);
    }
    store.on('media', () => this.tab === 'media' || this.tab === 'audio' ? this.scheduleRender() : null);
    store.on('load', () => this.render());
    store.on('change', () => this.tab === 'media' && this.updateUsage());
    store.on('selection', () => this.tab === 'filters' && this.scheduleRender());
    media.addEventListener('change', (e) => this.onMediaChange(e.detail?.id));
    window.addEventListener('litecut:fonts', () => this.tab === 'text' && this.scheduleRender());
    this.show(this.tab);
  }

  show(id) {
    this.tab = id;
    localStorage.setItem('litecut.tab', id);
    for (const b of this.tabsRoot.children) b.classList.toggle('on', b.dataset.tab === id);
    this.render();
  }

  scheduleRender() {
    if (this._rq) return;
    this._rq = requestAnimationFrame(() => {
      this._rq = null;
      this.render();
    });
  }

  render() {
    clear(this.root);
    const fn = {
      media: () => this.mediaPanel(),
      audio: () => this.audioPanel(),
      text: () => this.textPanel(),
      stickers: () => this.stickerPanel(),
      transitions: () => this.transitionPanel(),
      filters: () => this.filterPanel(),
      record: () => this.recordPanel(),
    }[this.tab];
    this.root.append(fn ? fn() : h('div'));
  }

  head(title, ...extra) {
    return h('div', { class: 'panel-head' }, h('h3', {}, title), h('div', { class: 'panel-head-x' }, ...extra));
  }

  // ---------- Medios ----------
  mediaPanel() {
    const wrap = h('div', { class: 'pnl' });
    wrap.append(
      this.head('Medios', btn('Importar', { kind: 'primary small', icon: 'import', onClick: () => this.actions.importMedia() })),
      segmented({
        options: [
          { value: 'all', label: 'Todo' },
          { value: 'video', label: 'Video' },
          { value: 'image', label: 'Imagen' },
          { value: 'audio', label: 'Audio' },
        ],
        value: this.filter,
        small: true,
        onChange: (v) => {
          this.filter = v;
          this.render();
        },
      })
    );
    const list = store.project.media.filter((m) => this.filter === 'all' || m.kind === this.filter);
    if (!store.project.media.length) {
      const drop = h(
        'button',
        { class: 'dropzone', type: 'button' },
        h('span', { html: icon('import', 34) }),
        h('b', {}, 'Importa tus archivos'),
        h('span', {}, 'Arrastra videos, fotos o música aquí, o haz clic para buscarlos'),
        h('small', {}, 'MP4, MOV, MKV, AVI, WebM, MP3, WAV, JPG, PNG y más')
      );
      drop.addEventListener('click', () => this.actions.importMedia());
      wrap.append(drop, h('div', { class: 'or-sep' }, 'o'), btn('Grabar la pantalla', { kind: 'rec-btn', icon: 'record', onClick: () => this.actions.openRecorder() }));
      return wrap;
    }
    const grid = h('div', { class: 'media-grid' });
    for (const m of list) grid.append(this.mediaCard(m));
    if (!list.length) grid.append(h('p', { class: 'hint' }, 'No hay archivos de este tipo.'));
    wrap.append(grid);
    this.updateUsage(wrap);
    return wrap;
  }

  mediaCard(m) {
    const st = media.getStatus(m.id);
    const thumb = h('div', { class: `mc-thumb k-${m.kind}` });
    const poster = media.poster(m);
    if (poster) thumb.style.backgroundImage = `url("${poster.src}")`;
    else thumb.innerHTML = icon(m.kind === 'audio' ? 'music' : m.kind === 'image' ? 'image' : 'film', 26);
    if (m.kind !== 'image') thumb.append(h('span', { class: 'mc-dur' }, formatDurationShort(m.duration)));
    if (m.missing) thumb.append(h('span', { class: 'mc-status err' }, 'Archivo no encontrado'));
    else if (st.state === 'proxy') thumb.append(h('span', { class: 'mc-status' }, `Optimizando ${Math.round((st.progress || 0) * 100)}%`));
    else if (st.state === 'checking') thumb.append(h('span', { class: 'mc-status' }, 'Analizando…'));
    else if (st.state === 'error') thumb.append(h('span', { class: 'mc-status err' }, 'Error'));
    const add = h('button', { class: 'mc-add', type: 'button', title: 'Añadir a la línea de tiempo', html: icon('plus', 16) });
    add.addEventListener('click', (e) => {
      e.stopPropagation();
      edit.addMediaClip(m.id);
    });
    const card = h('div', { class: `media-card${m.missing ? ' missing' : ''}`, dataset: { id: m.id }, title: `${m.name}\n${m.width ? `${m.width}×${m.height} · ` : ''}${fmtBytes(m.size)}` }, thumb, add, h('div', { class: 'mc-name' }, h('i', { class: 'mc-used' }), m.name));
    card.addEventListener('dblclick', () => edit.addMediaClip(m.id));
    card.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      contextMenu(e.clientX, e.clientY, [
        { label: 'Añadir a la línea de tiempo', icon: 'plus', onClick: () => edit.addMediaClip(m.id) },
        { label: 'Mostrar en la carpeta', icon: 'folder', onClick: () => window.api.shell.showItem(m.path) },
        m.missing ? { label: 'Buscar archivo…', icon: 'link', onClick: () => this.relink(m) } : null,
        'sep',
        { label: 'Quitar del proyecto', icon: 'trash', danger: true, onClick: () => this.removeMedia(m) },
      ]);
    });
    makeDraggable(card, () => ({ type: 'media', id: m.id, duration: m.kind === 'image' ? 5 : m.duration }), m.name);
    return card;
  }

  updateUsage(root = this.root) {
    const used = new Set(store.project.clips.map((c) => c.mediaId));
    for (const card of root.querySelectorAll('.media-card')) card.classList.toggle('used', used.has(card.dataset.id));
  }

  onMediaChange(id) {
    if (this.tab !== 'media' && this.tab !== 'audio') return;
    const m = id && store.getMedia(id);
    const card = m && this.root.querySelector(`.media-card[data-id="${id}"]`);
    if (card && this.tab === 'media') card.replaceWith(this.mediaCard(m));
    else this.scheduleRender();
    this.updateUsage();
  }

  async relink(m) {
    const p = await window.api.dialog.openFile({ title: `Buscar «${m.name}»` });
    if (p) await media.relink(m, p);
  }

  async removeMedia(m) {
    const n = store.project.clips.filter((c) => c.mediaId === m.id).length;
    if (n && !(await confirmDialog({ title: 'Quitar del proyecto', message: `«${m.name}» se usa en ${n} clip(s) de la línea de tiempo. Se eliminarán también esos clips (esta acción no se puede deshacer).`, ok: 'Quitar', danger: true }))) return;
    media.forget(m.id);
    store.removeMedia(m.id);
  }

  // ---------- Audio ----------
  audioPanel() {
    const wrap = h('div', { class: 'pnl' });
    wrap.append(
      this.head('Audio'),
      h(
        'div',
        { class: 'big-actions' },
        btn('Importar música', { kind: 'primary', icon: 'music', onClick: () => this.actions.importMedia('audio') }),
        btn('Grabar voz en off', { kind: '', icon: 'mic', onClick: () => this.actions.openVoiceover() })
      )
    );
    const list = store.project.media.filter((m) => m.hasAudio);
    if (!list.length) {
      wrap.append(h('p', { class: 'hint' }, 'Importa canciones o efectos (MP3, WAV, M4A…). También aparecen aquí los videos con sonido. Usa música libre de derechos para publicar sin problemas.'));
      return wrap;
    }
    const ul = h('div', { class: 'audio-list' });
    for (const m of list) {
      const playing = this.previewAudio?.dataset.id === m.id && !this.previewAudio.paused;
      const play = h('button', { class: 'ibtn', type: 'button', title: playing ? 'Detener' : 'Escuchar', html: icon(playing ? 'stop' : 'play', 14) });
      play.addEventListener('click', (e) => {
        e.stopPropagation();
        this.togglePreview(m);
      });
      const add = h('button', { class: 'ibtn', type: 'button', title: 'Añadir en el cursor', html: icon('plus', 16) });
      add.addEventListener('click', (e) => {
        e.stopPropagation();
        edit.addMediaClip(m.id);
      });
      const row = h('div', { class: 'audio-row', dataset: { id: m.id } }, play, h('div', { class: 'ar-info' }, h('b', {}, m.name), h('span', {}, `${formatDurationShort(m.duration)} · ${m.kind === 'audio' ? 'Audio' : 'Video con sonido'}`)), add);
      makeDraggable(row, () => ({ type: 'media', id: m.id, duration: m.duration }), m.name);
      ul.append(row);
    }
    wrap.append(ul);
    return wrap;
  }

  togglePreview(m) {
    if (this.previewAudio && this.previewAudio.dataset.id === m.id && !this.previewAudio.paused) {
      this.previewAudio.pause();
      this.render();
      return;
    }
    if (this.previewAudio) this.previewAudio.pause();
    const a = new Audio(window.api.mediaUrl(media.previewPath(m)));
    a.dataset.id = m.id;
    a.addEventListener('ended', () => this.render());
    a.play().catch(() => toast('No se pudo reproducir este audio', { type: 'error' }));
    this.previewAudio = a;
    setTimeout(() => this.render(), 50);
  }

  // ---------- Texto ----------
  textPanel() {
    const wrap = h('div', { class: 'pnl' });
    wrap.append(this.head('Texto', btn('Añadir texto', { kind: 'primary small', icon: 'plus', onClick: () => edit.addText('title') })));
    const grid = h('div', { class: 'text-grid' });
    for (const pr of TEXT_PRESETS) {
      const t = { ...defaultText(), ...pr.text };
      ensureFont(t);
      const cv = renderTextCanvas({ ...t, content: pr.text.content.split('\n')[0] }, 0.3);
      const holder = h('div', { class: 'tp-canvas' });
      holder.append(cv);
      const card = h('button', { class: 'text-card', type: 'button', title: `Añadir «${pr.name}»` }, holder, h('span', {}, pr.name));
      card.addEventListener('click', () => edit.addText(pr.id));
      makeDraggable(card, () => ({ type: 'text', id: pr.id, duration: 4 }), pr.name);
      grid.append(card);
    }
    wrap.append(grid, h('p', { class: 'hint' }, 'Haz clic para añadir en la posición del cursor o arrástralo a la línea de tiempo. Doble clic en un texto del visor para editarlo.'));
    return wrap;
  }

  stickerPanel() {
    const wrap = h('div', { class: 'pnl' });
    wrap.append(this.head('Stickers'));
    const grid = h('div', { class: 'sticker-grid' });
    for (const s of STICKERS) {
      const b = h('button', { class: 'sticker', type: 'button', title: 'Añadir sticker' }, s);
      b.addEventListener('click', () => edit.addSticker(s));
      makeDraggable(b, () => ({ type: 'sticker', emoji: s, duration: 3 }), s);
      grid.append(b);
    }
    wrap.append(grid, h('p', { class: 'hint' }, 'Los stickers aparecen con un pequeño rebote. Cámbiales tamaño, posición y animación en el panel derecho.'));
    return wrap;
  }

  // ---------- Transiciones ----------
  transitionPanel() {
    const wrap = h('div', { class: 'pnl' });
    wrap.append(this.head('Transiciones'));
    const grid = h('div', { class: 'trans-grid big' });
    for (const t of TRANSITIONS) {
      const b = h('button', { class: 'trans-item', type: 'button', title: `Aplicar «${t.name}»` }, h('span', { class: `tr-prev tp-${t.id}` }, h('i')), h('span', {}, t.name));
      b.addEventListener('click', () => edit.applyTransitionNearPlayhead(t.id));
      makeDraggable(b, () => ({ type: 'transition', id: t.id }), t.name);
      grid.append(b);
    }
    wrap.append(grid, h('p', { class: 'hint' }, 'Arrastra una transición a la unión de dos clips de la pista principal, o haz clic para aplicarla en la unión más cercana al cursor. También puedes pulsar el botón «+» entre dos clips.'));
    return wrap;
  }

  // ---------- Filtros ----------
  filterPanel() {
    const wrap = h('div', { class: 'pnl' });
    const sel = store.selectedClips.filter((c) => c.type === 'video' || c.type === 'image');
    wrap.append(this.head('Filtros'));
    const m = sel[0] ? store.getMedia(sel[0].mediaId) : store.project.media.find((x) => x.kind !== 'audio');
    const poster = m ? media.poster(m) : null;
    const grid = h('div', { class: 'filter-grid big' });
    for (const f of FILTER_PRESETS) {
      const cv = h('canvas', { width: 116, height: 70 });
      const ctx = cv.getContext('2d');
      ctx.filter = cssFilterFor({ ...defaultAdjust(), ...f.adjust }, 116 / 1920).filter;
      if (poster) {
        const iw = poster.naturalWidth || poster.width;
        const ih = poster.naturalHeight || poster.height;
        const s = Math.max(116 / iw, 70 / ih);
        ctx.drawImage(poster, (116 - iw * s) / 2, (70 - ih * s) / 2, iw * s, ih * s);
      } else {
        const g = ctx.createLinearGradient(0, 0, 116, 70);
        g.addColorStop(0, '#f6a04d');
        g.addColorStop(0.5, '#3fb6a8');
        g.addColorStop(1, '#4a5bd8');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, 116, 70);
      }
      const on = sel.length && sel.every((c) => (c.filter || 'none') === f.id);
      const b = h('button', { class: `filter-item${on ? ' on' : ''}`, type: 'button' }, cv, h('span', {}, f.name));
      b.addEventListener('click', () => edit.applyFilterPreset(sel.map((c) => c.id), f.id));
      makeDraggable(b, () => ({ type: 'filter', id: f.id }), f.name);
      grid.append(b);
    }
    wrap.append(
      h('p', { class: 'hint' }, sel.length ? `Se aplicará a ${sel.length === 1 ? 'el clip seleccionado' : `${sel.length} clips`}.` : 'Selecciona un clip de video o imagen, o arrastra un filtro sobre un clip.'),
      grid
    );
    return wrap;
  }

  // ---------- Grabar ----------
  recordPanel() {
    const wrap = h('div', { class: 'pnl' });
    const mod = window.api.platform === 'darwin' ? '⌘' : 'Ctrl';
    const card = (ic, title, text, onClick, kind = '') => {
      const b = h('button', { class: `rec-card ${kind}`, type: 'button' }, h('span', { class: 'rc-ic', html: icon(ic, 26) }), h('span', { class: 'rc-txt' }, h('b', {}, title), h('span', {}, text)));
      b.addEventListener('click', onClick);
      return b;
    };
    wrap.append(
      this.head('Grabar'),
      card('monitor', 'Grabar pantalla', 'Pantalla completa, una ventana o un área. Con micrófono, audio del sistema y cámara.', () => this.actions.openRecorder(), 'main'),
      card('mic', 'Grabar voz en off', 'Narra sobre tu video mientras se reproduce.', () => this.actions.openVoiceover()),
      card('folder', 'Abrir carpeta de grabaciones', 'Videos › LiteCut Studio', () => window.api.shell.openRecordings()),
      h(
        'div',
        { class: 'tips' },
        h('b', {}, 'Durante la grabación'),
        h('div', {}, h('kbd', {}, `${mod}+Alt+S`), ' detener'),
        h('div', {}, h('kbd', {}, `${mod}+Alt+P`), ' pausar / reanudar'),
        h('p', { class: 'hint' }, 'La barra de control flotante no aparece en el video. La cámara se guarda en una pista aparte para que puedas moverla y cambiarle el tamaño.')
      )
    );
    return wrap;
  }
}
