// Panel de propiedades: muestra y edita el clip, la transición o el proyecto seleccionado.
import { store } from './store.js';
import { media } from './media.js';
import * as edit from './edit.js';
import * as ops from '../shared/ops.js';
import { h, clear, sliderRow, selectRow, colorRow, toggleRow, segmented, section, btn } from './ui.js';
import { icon } from './icons.js';
import { ADJUST_FIELDS, FILTER_PRESETS, ANIMS_IN, ANIMS_OUT, KENBURNS, TRANSITIONS, MASKS } from '../shared/effects.js';
import { ASPECTS, formatTime, projectDuration, defaultAdjust, defaultTransform, defaultText, trackClips, clone, mainTrack } from '../shared/model.js';
import { FONTS, TEXT_PRESETS, ensureFont } from './text-render.js';
import { cssFilterFor } from './render.js';
import { cropRect } from '../shared/layout.js';

const TYPE_NAMES = { video: 'Video', image: 'Imagen', audio: 'Audio', text: 'Texto' };
const WEIGHTS = [
  { value: 300, label: 'Fina' },
  { value: 400, label: 'Normal' },
  { value: 600, label: 'Semi negrita' },
  { value: 700, label: 'Negrita' },
  { value: 800, label: 'Extra negrita' },
  { value: 900, label: 'Black' },
];

export class Inspector {
  constructor(root, { player, onShortcuts }) {
    this.root = root;
    this.player = player;
    this.onShortcuts = onShortcuts;
    this.tabs = {};
    this.binds = [];
    this.sig = '';
    store.on('selection', () => this.render());
    store.on('load', () => this.render());
    store.on('change', (d) => {
      if (d?.kind !== 'live' && this.signature() !== this.sig) this.render();
      else this.refreshValues();
    });
    media.addEventListener('change', () => {
      if (this.root.querySelector('.filter-grid') && !this._posterOk) this.scheduleRender();
    });
    this.render();
  }

  scheduleRender() {
    if (this._rq) return;
    this._rq = setTimeout(() => {
      this._rq = null;
      this.render();
    }, 300);
  }

  signature() {
    const c = store.singleSelected;
    const t = store.selectedTransition ? store.getClip(store.selectedTransition) : null;
    const s = store.project.settings;
    return [
      store.selection.size,
      c?.id,
      c?.type,
      c && this.tabs[c.type],
      c?.filter,
      c?.mask,
      c?.animIn?.type,
      c?.animOut?.type,
      c?.kenburns,
      c?.bgFill,
      c?.linkedTo,
      c?.muted,
      c?.text?.font,
      c?.text?.align,
      c?.text?.italic,
      c?.text?.uppercase,
      c?.text?.weight,
      c?.transform?.flipH,
      c?.transform?.flipV,
      c && store.getMedia(c.mediaId)?.hasAudio,
      store.selectedTransition,
      t?.transitionIn?.type,
      s.aspect,
      s.width,
      s.height,
      s.fps,
      store.project.name,
      store.project.clips.length,
    ].join('|');
  }

  refreshValues() {
    for (const b of this.binds) {
      try {
        b.row.setValue(b.get());
      } catch {
        /* control ya no existe */
      }
    }
  }

  // ---------- Controles enlazados ----------
  slider(label, get, set, opts = {}) {
    const id = this.clipId;
    const row = sliderRow({
      label,
      value: get(store.getClip(id)),
      ...opts,
      onStart: () => store.beginEdit(),
      onInput: (v) =>
        store.live((p) => {
          const c = ops.findClip(p, id);
          if (c) set(c, v, p);
        }),
      onChange: () => store.commitEdit(),
    });
    this.binds.push({ row, get: () => (store.getClip(id) ? get(store.getClip(id)) : 0) });
    return row;
  }

  choose(label, options, get, set) {
    const id = this.clipId;
    const row = selectRow({
      label,
      value: get(store.getClip(id)),
      options,
      onChange: (v) =>
        store.mutate((p) => {
          const c = ops.findClip(p, id);
          if (c) set(c, v, p);
        }),
    });
    this.binds.push({ row, get: () => get(store.getClip(id)) });
    return row;
  }

  color(label, get, set) {
    const id = this.clipId;
    const row = colorRow({
      label,
      value: get(store.getClip(id)),
      onStart: () => store.beginEdit(),
      onInput: (v) =>
        store.live((p) => {
          const c = ops.findClip(p, id);
          if (c) set(c, v);
        }),
      onChange: () => store.commitEdit(),
    });
    this.binds.push({ row, get: () => get(store.getClip(id)) });
    return row;
  }

  toggle(label, get, set) {
    const id = this.clipId;
    const row = toggleRow({
      label,
      value: get(store.getClip(id)),
      onChange: (v) =>
        store.mutate((p) => {
          const c = ops.findClip(p, id);
          if (c) set(c, v, p);
        }),
    });
    this.binds.push({ row, get: () => get(store.getClip(id)) });
    return row;
  }

  // ---------- Renderizado ----------
  render() {
    this.sig = this.signature();
    this.binds = [];
    this._posterOk = true;
    const root = clear(this.root);
    const sel = store.selectedClips;
    if (store.selectedTransition && store.getClip(store.selectedTransition)?.transitionIn) {
      root.append(this.transitionPanel(store.getClip(store.selectedTransition)));
      return;
    }
    if (sel.length > 1) {
      root.append(this.multiPanel(sel));
      return;
    }
    if (sel.length === 1) {
      root.append(this.clipPanel(sel[0]));
      return;
    }
    root.append(this.projectPanel());
  }

  header(title, sub, actions = []) {
    return h('div', { class: 'insp-head' }, h('div', { class: 'insp-title' }, h('b', {}, title), sub ? h('span', {}, sub) : null), h('div', { class: 'insp-actions' }, ...actions));
  }

  clipPanel(c) {
    this.clipId = c.id;
    const m = c.mediaId ? store.getMedia(c.mediaId) : null;
    const wrap = h('div', { class: 'insp' });
    const name = c.type === 'text' ? (c.text.content || 'Texto').split('\n')[0].slice(0, 28) : c.name || m?.name || TYPE_NAMES[c.type];
    wrap.append(
      this.header(name, `${TYPE_NAMES[c.type]} · ${formatTime(c.start, store.project.settings.fps, true)} · ${c.duration.toFixed(2)} s`, [
        h('button', { class: 'ibtn', title: 'Duplicar', html: icon('copy', 16), onclick: () => edit.duplicateSelected() }),
        h('button', { class: 'ibtn danger', title: 'Eliminar', html: icon('trash', 16), onclick: () => edit.deleteSelected(false) }),
      ])
    );
    const tabs = [];
    if (c.type === 'video') tabs.push(['clip', 'Video'], ['color', 'Color'], ['anim', 'Animación'], ['speed', 'Velocidad']);
    if (c.type === 'image') tabs.push(['clip', 'Imagen'], ['color', 'Color'], ['anim', 'Animación']);
    if (c.type === 'text') tabs.push(['text', 'Texto'], ['clip', 'Posición'], ['anim', 'Animación']);
    if (c.type === 'audio') tabs.push(['audio', 'Audio'], ['speed', 'Velocidad']);
    if (c.type === 'video' && m?.hasAudio) tabs.push(['audio', 'Audio']);
    let tab = this.tabs[c.type];
    if (!tabs.some(([k]) => k === tab)) tab = tabs[0][0];
    wrap.append(
      segmented({
        options: tabs.map(([value, label]) => ({ value, label })),
        value: tab,
        small: true,
        onChange: (v) => {
          this.tabs[c.type] = v;
          this.render();
        },
      })
    );
    const body = h('div', { class: 'insp-body' });
    if (tab === 'clip') body.append(this.clipTab(c, m));
    if (tab === 'color') body.append(this.colorTab(c, m));
    if (tab === 'anim') body.append(this.animTab(c));
    if (tab === 'speed') body.append(this.speedTab(c, m));
    if (tab === 'audio') body.append(this.audioTab(c, m));
    if (tab === 'text') body.append(this.textTab(c));
    wrap.append(body);
    return wrap;
  }

  clipTab(c, m) {
    const p = store.project;
    const PW = p.settings.width;
    const PH = p.settings.height;
    const box = h('div');
    const quick = h(
      'div',
      { class: 'btn-row' },
      btn('Ajustar', { kind: 'small', title: 'Encajar dentro del lienzo', onClick: () => this.setTransform({ scale: 1, x: 0, y: 0 }) }),
      c.type !== 'text' ? btn('Rellenar', { kind: 'small', title: 'Cubrir todo el lienzo', onClick: () => this.fillCanvas(c, m) }) : null,
      btn('Centrar', { kind: 'small', onClick: () => this.setTransform({ x: 0, y: 0 }) }),
      c.type !== 'text'
        ? h('button', { class: `ibtn${c.transform.flipH ? ' active' : ''}`, title: 'Voltear horizontal', html: icon('flipH', 16), onclick: () => this.setTransform({ flipH: !c.transform.flipH }) })
        : null,
      c.type !== 'text'
        ? h('button', { class: `ibtn${c.transform.flipV ? ' active' : ''}`, title: 'Voltear vertical', html: icon('flipV', 16), onclick: () => this.setTransform({ flipV: !c.transform.flipV }) })
        : null,
      h('button', { class: 'ibtn', title: 'Restablecer transformación', html: icon('rotate', 16), onclick: () => this.setTransform(defaultTransform()) })
    );
    box.append(
      section(
        'Transformación',
        h(
          'div',
          {},
          this.slider('Escala', (x) => Math.round(x.transform.scale * 100), (x, v) => (x.transform.scale = v / 100), { min: 5, max: 400, unit: '%', defaultValue: 100 }),
          this.slider('Posición X', (x) => Math.round(x.transform.x), (x, v) => (x.transform.x = v), { min: -PW, max: PW, unit: 'px', defaultValue: 0 }),
          this.slider('Posición Y', (x) => Math.round(x.transform.y), (x, v) => (x.transform.y = v), { min: -PH, max: PH, unit: 'px', defaultValue: 0 }),
          this.slider('Rotación', (x) => x.transform.rotation, (x, v) => (x.transform.rotation = v), { min: -180, max: 180, unit: '°', defaultValue: 0 }),
          this.slider('Opacidad', (x) => Math.round(x.transform.opacity * 100), (x, v) => (x.transform.opacity = v / 100), { min: 0, max: 100, unit: '%', defaultValue: 100 }),
          quick
        )
      )
    );
    if (c.type === 'video' || c.type === 'image') {
      box.append(
        section(
          'Recortar y máscara',
          h(
            'div',
            {},
            this.slider('Izquierda', (x) => Math.round(x.crop.l * 100), (x, v) => (x.crop.l = v / 100), { min: 0, max: 45, unit: '%', defaultValue: 0 }),
            this.slider('Derecha', (x) => Math.round(x.crop.r * 100), (x, v) => (x.crop.r = v / 100), { min: 0, max: 45, unit: '%', defaultValue: 0 }),
            this.slider('Arriba', (x) => Math.round(x.crop.t * 100), (x, v) => (x.crop.t = v / 100), { min: 0, max: 45, unit: '%', defaultValue: 0 }),
            this.slider('Abajo', (x) => Math.round(x.crop.b * 100), (x, v) => (x.crop.b = v / 100), { min: 0, max: 45, unit: '%', defaultValue: 0 }),
            h(
              'div',
              { class: 'ctl' },
              h('label', {}, 'Máscara'),
              segmented({
                options: MASKS.map((k) => ({ value: k.id, label: k.name })),
                value: c.mask || 'none',
                small: true,
                onChange: (v) => store.mutate((p) => (ops.findClip(p, c.id).mask = v)),
              })
            ),
            h('div', { class: 'btn-row' }, btn('Recorte cuadrado', { kind: 'small', title: 'Ideal para la cámara en círculo', onClick: () => this.squareCrop(c, m) }))
          ),
          { open: false }
        )
      );
    }
    const main = mainTrack(store.project);
    if ((c.type === 'video' || c.type === 'image') && main && c.trackId === main.id) {
      box.append(
        section(
          'Fondo del lienzo',
          h(
            'div',
            {},
            segmented({
              options: [
                { value: 'none', label: 'Color' },
                { value: 'blur', label: 'Desenfocado' },
              ],
              value: c.bgFill || 'none',
              small: true,
              onChange: (v) => store.mutate((p) => (ops.findClip(p, c.id).bgFill = v)),
            }),
            h('p', { class: 'hint' }, 'Rellena las barras con el mismo video desenfocado (ideal para pasar videos horizontales a 9:16).'),
            h('div', { class: 'btn-row' }, btn('Aplicar a toda la pista principal', { kind: 'small', onClick: () => this.blurAllMain(store.getClip(c.id)?.bgFill || 'none') }))
          )
        )
      );
    }
    if (c.type === 'image' || c.type === 'text') box.append(section('Duración', this.durationSlider()));
    return box;
  }

  blurAllMain(value) {
    const main = mainTrack(store.project);
    if (!main) return;
    store.mutate((p) => {
      for (const x of p.clips) if (x.trackId === main.id && (x.type === 'video' || x.type === 'image')) x.bgFill = value;
    });
  }

  durationSlider() {
    return this.slider('Duración', (x) => x.duration, (x, v, p) => ops.setDuration(p, x.id, v), { min: 0.2, max: 60, step: 0.1, decimals: 1, unit: 's' });
  }

  setTransform(patch) {
    const id = this.clipId;
    store.mutate((p) => Object.assign(ops.findClip(p, id).transform, patch));
  }

  fillCanvas(c, m) {
    if (!m) return;
    const PW = store.project.settings.width;
    const PH = store.project.settings.height;
    const r = cropRect(c, m);
    const fit = Math.min(PW / r.w, PH / r.h);
    const cover = Math.max(PW / (r.w * fit), PH / (r.h * fit));
    this.setTransform({ scale: Math.round(cover * 1000) / 1000, x: 0, y: 0, rotation: 0 });
  }

  squareCrop(c, m) {
    if (!m) return;
    const id = c.id;
    store.mutate((p) => {
      const x = ops.findClip(p, id);
      if (m.width >= m.height) {
        const f = (1 - m.height / m.width) / 2;
        x.crop = { l: f, r: f, t: 0, b: 0 };
      } else {
        const f = (1 - m.width / m.height) / 2;
        x.crop = { l: 0, r: 0, t: f, b: f };
      }
    });
  }

  colorTab(c, m) {
    const box = h('div');
    const grid = h('div', { class: 'filter-grid' });
    const poster = m ? media.posterDrawable(m) : null;
    if (!poster) this._posterOk = false;
    for (const f of FILTER_PRESETS) {
      const cv = h('canvas', { width: 76, height: 48 });
      const ctx = cv.getContext('2d');
      const adj = { ...defaultAdjust(), ...f.adjust };
      if (poster) {
        ctx.filter = cssFilterFor(adj, 76 / store.project.settings.width).filter;
        const iw = poster.naturalWidth || poster.width;
        const ih = poster.naturalHeight || poster.height;
        const s = Math.max(76 / iw, 48 / ih);
        ctx.drawImage(poster, (76 - iw * s) / 2, (48 - ih * s) / 2, iw * s, ih * s);
      } else {
        ctx.filter = cssFilterFor(adj, 0.04).filter;
        const g = ctx.createLinearGradient(0, 0, 76, 48);
        g.addColorStop(0, '#f6a04d');
        g.addColorStop(0.5, '#3fb6a8');
        g.addColorStop(1, '#4a5bd8');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, 76, 48);
      }
      const item = h('button', { class: `filter-item${(c.filter || 'none') === f.id ? ' on' : ''}`, type: 'button', title: f.name }, cv, h('span', {}, f.name));
      item.addEventListener('click', () => edit.applyFilterPreset([c.id], f.id));
      grid.append(item);
    }
    box.append(section('Filtros', grid));
    const adj = h('div');
    for (const f of ADJUST_FIELDS) {
      adj.append(this.slider(f.label, (x) => x.adjust[f.key] || 0, (x, v) => (x.adjust[f.key] = v), { min: f.min, max: f.max, unit: f.unit || '', defaultValue: 0 }));
    }
    adj.append(
      h(
        'div',
        { class: 'btn-row' },
        btn('Restablecer color', {
          kind: 'small',
          onClick: () =>
            store.mutate((p) => {
              const x = ops.findClip(p, c.id);
              x.adjust = defaultAdjust();
              x.filter = 'none';
            }),
        })
      )
    );
    box.append(section('Ajustes', adj));
    return box;
  }

  animTab(c) {
    const box = h('div');
    const preview = btn('Ver animación', {
      kind: 'small',
      icon: 'play',
      onClick: () => {
        this.player.seek(c.start);
        this.player.play();
      },
    });
    box.append(
      section(
        'Entrada',
        h(
          'div',
          {},
          this.choose('Animación', ANIMS_IN.map((a) => ({ value: a.id, label: a.name })), (x) => x.animIn.type, (x, v) => (x.animIn.type = v)),
          this.slider('Duración', (x) => x.animIn.duration, (x, v) => (x.animIn.duration = v), { min: 0.1, max: 3, step: 0.1, decimals: 1, unit: 's', defaultValue: 0.6 })
        )
      ),
      section(
        'Salida',
        h(
          'div',
          {},
          this.choose('Animación', ANIMS_OUT.map((a) => ({ value: a.id, label: a.name })), (x) => x.animOut.type, (x, v) => (x.animOut.type = v)),
          this.slider('Duración', (x) => x.animOut.duration, (x, v) => (x.animOut.duration = v), { min: 0.1, max: 3, step: 0.1, decimals: 1, unit: 's', defaultValue: 0.6 })
        )
      )
    );
    if (c.type === 'image' || c.type === 'video') {
      box.append(section('Movimiento lento (Ken Burns)', this.choose('Efecto', KENBURNS.map((k) => ({ value: k.id, label: k.name })), (x) => x.kenburns || 'none', (x, v) => (x.kenburns = v))));
    }
    box.append(h('div', { class: 'btn-row' }, preview));
    return box;
  }

  speedTab(c, m) {
    const box = h('div');
    const presets = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4];
    box.append(
      section(
        'Velocidad',
        h(
          'div',
          {},
          segmented({
            options: presets.map((v) => ({ value: v, label: `${v}×` })),
            value: presets.find((v) => Math.abs(v - c.speed) < 1e-3) ?? '',
            small: true,
            onChange: (v) => store.mutate((p) => ops.setSpeed(p, c.id, v)),
          }),
          this.slider('Personalizada', (x) => x.speed, (x, v, p) => ops.setSpeed(p, x.id, v), { min: 0.1, max: 8, step: 0.05, decimals: 2, unit: '×', defaultValue: 1 }),
          h('p', { class: 'hint' }, `Fragmento original: ${(c.duration * c.speed).toFixed(2)} s · En la línea de tiempo: ${c.duration.toFixed(2)} s. El tono de la voz se conserva.`)
        )
      )
    );
    if (m && c.speed > 1.01 && m.hasAudio) box.append(h('p', { class: 'hint' }, 'Consejo: a más de 2× el audio suena acelerado; puedes silenciarlo en la pestaña Audio.'));
    return box;
  }

  audioTab(c, m) {
    const box = h('div');
    const rows = h(
      'div',
      {},
      this.slider('Volumen', (x) => Math.round((x.volume ?? 1) * 100), (x, v) => (x.volume = v / 100), { min: 0, max: 200, unit: '%', defaultValue: 100 }),
      this.slider('Fundido de entrada', (x) => x.fadeIn || 0, (x, v) => (x.fadeIn = v), { min: 0, max: 10, step: 0.1, decimals: 1, unit: 's', defaultValue: 0 }),
      this.slider('Fundido de salida', (x) => x.fadeOut || 0, (x, v) => (x.fadeOut = v), { min: 0, max: 10, step: 0.1, decimals: 1, unit: 's', defaultValue: 0 })
    );
    if (c.type === 'video') {
      rows.append(
        this.toggle('Silenciar este clip', (x) => !!x.muted, (x, v, p) => {
          if (v) x.muted = true;
          else ops.reattachAudio(p, x.id); // quitar el silencio devuelve el audio separado
        })
      );
      if (m?.hasAudio && !c.muted) rows.append(h('div', { class: 'btn-row' }, btn('Separar audio a otra pista', { kind: 'small', icon: 'detach', onClick: () => edit.detachAudioSelected() })));
    }
    if (c.type === 'audio' && c.linkedTo) {
      rows.append(
        h('p', { class: 'hint' }, 'Este audio se separó de un video y lo sigue al moverlo, recortarlo o cambiar su velocidad.'),
        h('div', { class: 'btn-row' }, btn('Desvincular del video', { kind: 'small', icon: 'link', onClick: () => store.mutate((p) => (ops.findClip(p, c.id).linkedTo = null)) }))
      );
    }
    box.append(section('Audio', rows));
    return box;
  }

  textTab(c) {
    const id = c.id;
    const box = h('div');
    const ta = h('textarea', { rows: 3, class: 'text-content', spellcheck: 'false' });
    ta.value = c.text.content;
    ta.addEventListener('focus', () => store.beginEdit());
    ta.addEventListener('input', () =>
      store.live((p) => {
        ops.findClip(p, id).text.content = ta.value;
      })
    );
    ta.addEventListener('blur', () => store.commitEdit());
    this.binds.push({
      row: { setValue: (v) => document.activeElement !== ta && (ta.value = v) },
      get: () => store.getClip(id)?.text.content ?? '',
    });
    const chips = h('div', { class: 'chips' });
    for (const pr of TEXT_PRESETS) {
      const chip = h('button', { class: 'chip', type: 'button', style: { fontFamily: `"${pr.text.font}"`, fontWeight: pr.text.weight } }, pr.name);
      chip.addEventListener('click', () => {
        store.mutate((p) => {
          const x = ops.findClip(p, id);
          const content = x.text.content;
          x.text = { ...defaultText(), ...clone(pr.text), content };
        });
        ensureFont(store.getClip(id).text);
      });
      chips.append(chip);
    }
    const fontRow = this.choose(
      'Fuente',
      FONTS.map((f) => ({ value: f.family, label: f.family })),
      (x) => x.text.font,
      (x, v) => {
        x.text.font = v;
        ensureFont(x.text).then(() => window.dispatchEvent(new Event('litecut:fonts')));
      }
    );
    box.append(
      section('Contenido', h('div', {}, ta, h('p', { class: 'hint' }, 'Usa Intro para varias líneas. También puedes pegar emojis 😀'))),
      section('Estilos rápidos', chips, { open: false }),
      section(
        'Fuente',
        h(
          'div',
          {},
          fontRow,
          this.choose('Grosor', WEIGHTS, (x) => x.text.weight, (x, v) => (x.text.weight = +v)),
          this.slider('Tamaño', (x) => x.text.size, (x, v) => (x.text.size = v), { min: 8, max: 400, unit: 'px', defaultValue: 96 }),
          this.color('Color', (x) => x.text.color, (x, v) => (x.text.color = v)),
          h(
            'div',
            { class: 'ctl' },
            h('label', {}, 'Alineación'),
            segmented({
              options: [
                { value: 'left', label: 'Izq.' },
                { value: 'center', label: 'Centro' },
                { value: 'right', label: 'Der.' },
              ],
              value: c.text.align,
              small: true,
              onChange: (v) => store.mutate((p) => (ops.findClip(p, id).text.align = v)),
            })
          ),
          this.toggle('Cursiva', (x) => !!x.text.italic, (x, v) => (x.text.italic = v)),
          this.toggle('MAYÚSCULAS', (x) => !!x.text.uppercase, (x, v) => (x.text.uppercase = v)),
          this.slider('Espaciado', (x) => x.text.letterSpacing || 0, (x, v) => (x.text.letterSpacing = v), { min: -10, max: 60, unit: 'px', defaultValue: 0 }),
          this.slider('Interlineado', (x) => x.text.lineHeight, (x, v) => (x.text.lineHeight = v), { min: 0.7, max: 3, step: 0.05, decimals: 2, defaultValue: 1.15 })
        )
      ),
      section(
        'Contorno',
        h(
          'div',
          {},
          this.color('Color', (x) => x.text.strokeColor, (x, v) => (x.text.strokeColor = v)),
          this.slider('Grosor', (x) => x.text.strokeWidth || 0, (x, v) => (x.text.strokeWidth = v), { min: 0, max: 30, unit: 'px', defaultValue: 0 })
        ),
        { open: false }
      ),
      section(
        'Sombra',
        h(
          'div',
          {},
          this.color('Color', (x) => x.text.shadowColor, (x, v) => (x.text.shadowColor = v)),
          this.slider('Opacidad', (x) => Math.round((x.text.shadowOpacity ?? 0.6) * 100), (x, v) => (x.text.shadowOpacity = v / 100), { min: 0, max: 100, unit: '%', defaultValue: 60 }),
          this.slider('Desenfoque', (x) => x.text.shadowBlur || 0, (x, v) => (x.text.shadowBlur = v), { min: 0, max: 60, unit: 'px', defaultValue: 0 }),
          this.slider('Desplaz. X', (x) => x.text.shadowX || 0, (x, v) => (x.text.shadowX = v), { min: -50, max: 50, unit: 'px', defaultValue: 0 }),
          this.slider('Desplaz. Y', (x) => x.text.shadowY || 0, (x, v) => (x.text.shadowY = v), { min: -50, max: 50, unit: 'px', defaultValue: 0 })
        ),
        { open: false }
      ),
      section(
        'Fondo',
        h(
          'div',
          {},
          this.color('Color', (x) => x.text.bgColor, (x, v) => (x.text.bgColor = v)),
          this.slider('Opacidad', (x) => Math.round((x.text.bgOpacity || 0) * 100), (x, v) => (x.text.bgOpacity = v / 100), { min: 0, max: 100, unit: '%', defaultValue: 0 }),
          this.slider('Relleno', (x) => x.text.bgPadding || 0, (x, v) => (x.text.bgPadding = v), { min: 0, max: 120, unit: 'px', defaultValue: 24 }),
          this.slider('Esquinas', (x) => x.text.bgRadius || 0, (x, v) => (x.text.bgRadius = v), { min: 0, max: 120, unit: 'px', defaultValue: 14 })
        ),
        { open: false }
      ),
      section('Duración', this.durationSlider(), { open: false })
    );
    return box;
  }

  transitionPanel(b) {
    const wrap = h('div', { class: 'insp' });
    const tr = b.transitionIn;
    wrap.append(this.header('Transición', TRANSITIONS.find((t) => t.id === tr.type)?.name || '', [h('button', { class: 'ibtn danger', title: 'Quitar transición', html: icon('trash', 16), onclick: () => edit.removeTransition(b.id) })]));
    const grid = h('div', { class: 'trans-grid' });
    for (const t of TRANSITIONS) {
      const item = h('button', { class: `trans-item${t.id === tr.type ? ' on' : ''}`, type: 'button' }, h('span', { class: `tr-prev tp-${t.id}` }, h('i')), h('span', {}, t.name));
      item.addEventListener('click', () => edit.applyTransition(b.id, t.id, store.getClip(b.id).transitionIn?.duration || 0.6));
      grid.append(item);
    }
    const list = trackClips(store.project, b.trackId);
    const i = list.findIndex((x) => x.id === b.id);
    const a = list[i - 1];
    const maxD = a ? Math.max(0.2, Math.min(a.duration - (a.transitionIn?.duration || 0), b.duration) - 0.05) : 2;
    const id = b.id;
    const dur = sliderRow({
      label: 'Duración',
      value: tr.duration,
      min: 0.1,
      max: Math.max(0.2, Math.min(4, maxD)),
      step: 0.05,
      decimals: 2,
      unit: 's',
      onStart: () => store.beginEdit(),
      onInput: (v) => store.live((p) => ops.applyTransition(p, id, ops.findClip(p, id).transitionIn?.type || 'fade', v)),
      onChange: () => store.commitEdit(),
    });
    this.binds.push({ row: dur, get: () => store.getClip(id)?.transitionIn?.duration || 0 });
    wrap.append(
      h('div', { class: 'insp-body' }, section('Tipo', grid), section('Duración', dur), h('p', { class: 'hint' }, 'La transición superpone el final del clip anterior con el inicio del siguiente.'), h('div', { class: 'btn-row' }, btn('Ver transición', { kind: 'small', icon: 'play', onClick: () => {
        this.player.seek(Math.max(0, b.start - 1));
        this.player.play();
      } })))
    );
    return wrap;
  }

  multiPanel(sel) {
    const wrap = h('div', { class: 'insp' });
    wrap.append(this.header(`${sel.length} clips seleccionados`, 'Edición en grupo'));
    const ids = sel.map((c) => c.id);
    const withAudio = sel.filter((c) => c.type === 'audio' || (c.type === 'video' && store.getMedia(c.mediaId)?.hasAudio));
    const body = h('div', { class: 'insp-body' });
    if (withAudio.length) {
      const first = withAudio[0];
      body.append(
        section(
          'Audio',
          sliderRow({
            label: 'Volumen',
            value: Math.round((first.volume ?? 1) * 100),
            min: 0,
            max: 200,
            unit: '%',
            defaultValue: 100,
            onStart: () => store.beginEdit(),
            onInput: (v) =>
              store.live((p) => {
                for (const c of withAudio) ops.findClip(p, c.id).volume = v / 100;
              }),
            onChange: () => store.commitEdit(),
          })
        )
      );
    }
    const grid = h('div', { class: 'filter-grid compact' });
    for (const f of FILTER_PRESETS) {
      const it = h('button', { class: 'filter-item text', type: 'button' }, h('span', {}, f.name));
      it.addEventListener('click', () => edit.applyFilterPreset(ids, f.id));
      grid.append(it);
    }
    body.append(section('Aplicar filtro a todos', grid));
    body.append(
      h(
        'div',
        { class: 'btn-row' },
        btn('Duplicar', { kind: 'small', icon: 'copy', onClick: () => edit.duplicateSelected() }),
        btn('Eliminar', { kind: 'small danger', icon: 'trash', onClick: () => edit.deleteSelected(false) })
      )
    );
    wrap.append(body);
    return wrap;
  }

  projectPanel() {
    const p = store.project;
    const s = p.settings;
    const wrap = h('div', { class: 'insp' });
    wrap.append(this.header('Proyecto', 'Ajustes generales'));
    const body = h('div', { class: 'insp-body' });
    const name = h('input', { type: 'text', value: p.name, class: 'name-input' });
    name.addEventListener('change', () => store.mutate((pp) => (pp.name = name.value.trim() || 'Proyecto sin título')));
    const aspects = h('div', { class: 'aspect-grid' });
    for (const a of ASPECTS) {
      const on = s.aspect === a.id;
      const ratio = a.w / a.h;
      const bw = ratio >= 1 ? 30 : 30 * ratio;
      const bh = ratio >= 1 ? 30 / ratio : 30;
      const b = h(
        'button',
        { class: `aspect-item${on ? ' on' : ''}`, type: 'button', title: `${a.w}×${a.h}` },
        h('span', { class: 'aspect-box', style: { width: `${bw}px`, height: `${bh}px` } }),
        h('b', {}, a.label),
        h('span', {}, a.sub)
      );
      b.addEventListener('click', () => this.setAspect(a));
      aspects.append(b);
    }
    const custom = h(
      'div',
      { class: 'res-row' },
      h('input', { type: 'number', min: 128, max: 7680, step: 2, value: s.width, class: 'num wide', id: 'res-w' }),
      h('span', {}, '×'),
      h('input', { type: 'number', min: 128, max: 7680, step: 2, value: s.height, class: 'num wide', id: 'res-h' }),
      btn('Aplicar', {
        kind: 'small',
        onClick: () => {
          const w = Math.round((+document.getElementById('res-w').value || s.width) / 2) * 2;
          const hh = Math.round((+document.getElementById('res-h').value || s.height) / 2) * 2;
          store.mutate((pp) => {
            pp.settings.width = Math.max(128, Math.min(7680, w));
            pp.settings.height = Math.max(128, Math.min(7680, hh));
            pp.settings.aspect = 'custom';
          });
        },
      })
    );
    const fpsRow = selectRow({
      label: 'Fotogramas/s',
      value: s.fps,
      options: [24, 25, 30, 50, 60].map((v) => ({ value: v, label: `${v} fps` })),
      onChange: (v) => store.mutate((pp) => (pp.settings.fps = +v)),
    });
    const bg = colorRow({
      label: 'Color de fondo',
      value: s.background,
      onStart: () => store.beginEdit(),
      onInput: (v) => store.live((pp) => (pp.settings.background = v)),
      onChange: () => store.commitEdit(),
    });
    const dur = projectDuration(p);
    body.append(
      section('Nombre', name),
      section('Formato del lienzo', h('div', {}, aspects, h('label', { class: 'sub-label' }, 'Resolución (px)'), custom)),
      section('Reproducción', h('div', {}, fpsRow, bg)),
      section(
        'Resumen',
        h(
          'div',
          { class: 'stats' },
          h('div', {}, h('span', {}, 'Duración'), h('b', {}, formatTime(dur, s.fps))),
          h('div', {}, h('span', {}, 'Clips'), h('b', {}, String(p.clips.length))),
          h('div', {}, h('span', {}, 'Medios'), h('b', {}, String(p.media.length))),
          h('div', {}, h('span', {}, 'Pistas'), h('b', {}, String(p.tracks.length)))
        )
      ),
      h('div', { class: 'btn-row' }, btn('Atajos de teclado', { kind: 'small', icon: 'keyboard', onClick: () => this.onShortcuts?.() })),
      h('p', { class: 'hint' }, 'Selecciona un clip en la línea de tiempo o en el visor para editar sus propiedades.')
    );
    wrap.append(body);
    return wrap;
  }

  setAspect(a) {
    store.mutate((p) => {
      p.settings.width = a.w;
      p.settings.height = a.h;
      p.settings.aspect = a.id;
    });
  }
}

