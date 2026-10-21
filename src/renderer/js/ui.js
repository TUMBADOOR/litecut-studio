// Utilidades de interfaz: creación de elementos, diálogos, avisos, menús contextuales y controles.
import { icon } from './icons.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export const iconEl = (name, size, cls) => {
  const s = document.createElement('span');
  s.className = 'icw';
  s.innerHTML = icon(name, size, cls);
  return s.firstChild;
};

export function btn(label, { icon: ic, kind = '', title, onClick, size = 16, disabled } = {}) {
  const b = h('button', { class: `btn ${kind}`, title, type: 'button', disabled, onclick: onClick });
  if (ic) b.insertAdjacentHTML('beforeend', icon(ic, size));
  if (label) b.append(h('span', {}, label));
  return b;
}

export function iconBtn(ic, title, onClick, { size = 18, kind = '', active = false } = {}) {
  const b = h('button', { class: `ibtn ${kind}${active ? ' active' : ''}`, title, type: 'button', onclick: onClick });
  b.innerHTML = icon(ic, size);
  return b;
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

// ---------- Avisos ----------
let toastHost = null;
export function toast(message, { type = 'info', timeout = 3800, actions = [] } = {}) {
  if (!toastHost) {
    toastHost = h('div', { class: 'toasts' });
    document.body.append(toastHost);
  }
  const t = h('div', { class: `toast ${type}` }, h('div', { class: 'toast-msg' }, message));
  const close = () => {
    t.classList.add('out');
    setTimeout(() => t.remove(), 200);
  };
  if (actions.length) {
    const row = h('div', { class: 'toast-actions' });
    for (const a of actions)
      row.append(
        h('button', {
          class: 'btn small',
          onclick: () => {
            a.onClick?.();
            close();
          },
        }, a.label)
      );
    t.append(row);
  }
  t.append(h('button', { class: 'toast-x', html: icon('close', 14), onclick: close, title: 'Cerrar' }));
  toastHost.append(t);
  if (timeout) setTimeout(close, timeout);
  return close;
}

// ---------- Diálogos ----------
const openModals = [];
export function modal({ title, body, buttons = [], width = 520, onClose, dismissible = true, className = '' }) {
  const overlay = h('div', { class: 'modal-overlay' });
  const box = h('div', { class: `modal ${className}`, style: { width: typeof width === 'number' ? `${width}px` : width }, role: 'dialog' });
  const head = h('div', { class: 'modal-head' }, h('h2', {}, title || ''));
  let closed = false;
  const close = (result) => {
    if (closed) return;
    // Mientras hay un proceso en curso (p. ej. exportando) no se cierra con clic fuera, X o Esc.
    if ((result === null || result === undefined) && overlay.classList.contains('busy')) return;
    closed = true;
    overlay.classList.add('out');
    setTimeout(() => overlay.remove(), 160);
    const i = openModals.indexOf(api);
    if (i >= 0) openModals.splice(i, 1);
    onClose?.(result);
  };
  if (dismissible) head.append(h('button', { class: 'ibtn', html: icon('close', 18), title: 'Cerrar', onclick: () => close(null) }));
  const content = h('div', { class: 'modal-body' });
  if (body) content.append(body);
  const foot = h('div', { class: 'modal-foot' });
  for (const b of buttons) {
    const el = h('button', { class: `btn ${b.kind || ''}`, type: 'button' }, b.label);
    el.addEventListener('click', async () => {
      const r = b.onClick ? await b.onClick() : undefined;
      if (b.close !== false && r !== false) close(b.value ?? r);
    });
    if (b.id) el.id = b.id;
    foot.append(el);
  }
  box.append(head, content);
  if (buttons.length) box.append(foot);
  overlay.append(box);
  if (dismissible) overlay.addEventListener('mousedown', (e) => e.target === overlay && close(null));
  document.body.append(overlay);
  const api = { el: box, body: content, foot, close, overlay, dismissible };
  openModals.push(api);
  setTimeout(() => {
    const f = box.querySelector('[autofocus]') || box.querySelector('.btn.primary');
    f?.focus();
  }, 30);
  return api;
}

export const hasOpenModal = () => openModals.length > 0;
export function closeTopModal() {
  const m = openModals[openModals.length - 1];
  if (m && m.dismissible) {
    m.close(null);
    return true;
  }
  return false;
}

export function confirmDialog({ title = 'Confirmar', message = '', ok = 'Aceptar', cancel = 'Cancelar', danger = false }) {
  return new Promise((resolve) => {
    modal({
      title,
      width: 440,
      body: h('p', { class: 'dialog-text' }, message),
      buttons: [
        { label: cancel, value: false },
        { label: ok, kind: danger ? 'danger' : 'primary', value: true },
      ],
      onClose: (r) => resolve(r === true),
    });
  });
}

export function choiceDialog({ title, message, choices }) {
  return new Promise((resolve) => {
    modal({
      title,
      width: 470,
      body: h('p', { class: 'dialog-text' }, message),
      buttons: choices.map((c) => ({ label: c.label, kind: c.kind, value: c.id })),
      onClose: (r) => resolve(r ?? null),
    });
  });
}

export function alertDialog(title, message, details) {
  const body = h('div', {}, h('p', { class: 'dialog-text' }, message));
  if (details) body.append(h('pre', { class: 'details' }, details));
  return new Promise((resolve) => modal({ title, width: 520, body, buttons: [{ label: 'Entendido', kind: 'primary' }], onClose: resolve }));
}

// ---------- Menú contextual ----------
let ctxMenu = null;
export function closeContextMenu() {
  if (ctxMenu) {
    ctxMenu.remove();
    ctxMenu = null;
  }
}
export function contextMenu(x, y, items) {
  closeContextMenu();
  const menu = h('div', { class: 'ctx-menu' });
  for (const it of items) {
    if (it === 'sep') {
      menu.append(h('div', { class: 'ctx-sep' }));
      continue;
    }
    if (!it) continue;
    const row = h(
      'button',
      { class: `ctx-item${it.danger ? ' danger' : ''}`, disabled: it.disabled, type: 'button' },
      h('span', { class: 'ctx-ic', html: it.icon ? icon(it.icon, 15) : '' }),
      h('span', { class: 'ctx-label' }, it.label),
      h('span', { class: 'ctx-key' }, it.shortcut || '')
    );
    row.addEventListener('click', () => {
      closeContextMenu();
      it.onClick?.();
    });
    menu.append(row);
  }
  document.body.append(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, window.innerWidth - r.width - 6)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - r.height - 6)}px`;
  ctxMenu = menu;
}
window.addEventListener('mousedown', (e) => {
  if (ctxMenu && !ctxMenu.contains(e.target)) closeContextMenu();
});
window.addEventListener('blur', closeContextMenu);

// ---------- Controles del inspector ----------
const fmtNum = (v, dec) => (dec === 0 ? String(Math.round(v)) : Number(v).toFixed(dec));

export function sliderRow({ label, value, min, max, step = 1, unit = '', decimals = 0, defaultValue, onStart, onInput, onChange }) {
  const row = h('div', { class: 'ctl slider' });
  const lab = h('label', { title: defaultValue !== undefined ? 'Doble clic para restablecer' : '' }, label);
  const range = h('input', { type: 'range', min, max, step, value });
  const num = h('input', { type: 'number', min, max, step, value: fmtNum(value, decimals), class: 'num' });
  const unitEl = unit ? h('span', { class: 'unit' }, unit) : null;
  let editing = false;
  const begin = () => {
    if (!editing) {
      editing = true;
      onStart?.();
    }
  };
  const end = () => {
    if (editing) {
      editing = false;
      onChange?.(parseFloat(range.value));
    }
  };
  range.addEventListener('pointerdown', begin);
  range.addEventListener('input', () => {
    begin();
    num.value = fmtNum(range.value, decimals);
    onInput?.(parseFloat(range.value));
  });
  range.addEventListener('change', end);
  range.addEventListener('pointerup', end);
  num.addEventListener('change', () => {
    let v = parseFloat(num.value);
    if (!isFinite(v)) v = parseFloat(range.value);
    v = Math.min(max, Math.max(min, v));
    num.value = fmtNum(v, decimals);
    range.value = v;
    begin();
    onInput?.(v);
    end();
  });
  num.addEventListener('keydown', (e) => e.key === 'Enter' && num.blur());
  if (defaultValue !== undefined)
    lab.addEventListener('dblclick', () => {
      range.value = defaultValue;
      num.value = fmtNum(defaultValue, decimals);
      begin();
      onInput?.(defaultValue);
      end();
    });
  row.append(lab, h('div', { class: 'ctl-in' }, range, num, unitEl));
  row.setValue = (v) => {
    if (document.activeElement === num || editing) return;
    range.value = v;
    num.value = fmtNum(v, decimals);
  };
  return row;
}

export function selectRow({ label, value, options, onChange }) {
  const sel = h('select', {}, ...options.map((o) => h('option', { value: o.value, selected: String(o.value) === String(value) }, o.label)));
  sel.addEventListener('change', () => onChange?.(sel.value));
  const row = h('div', { class: 'ctl' }, h('label', {}, label), h('div', { class: 'ctl-in' }, sel));
  row.setValue = (v) => (sel.value = v);
  return row;
}

export function colorRow({ label, value, onStart, onInput, onChange }) {
  const inp = h('input', { type: 'color', value: value || '#ffffff' });
  const hex = h('input', { type: 'text', value: (value || '#ffffff').toUpperCase(), class: 'hex', maxlength: 7 });
  let started = false;
  inp.addEventListener('input', () => {
    if (!started) {
      started = true;
      onStart?.();
    }
    hex.value = inp.value.toUpperCase();
    onInput?.(inp.value);
  });
  inp.addEventListener('change', () => {
    started = false;
    onChange?.(inp.value);
  });
  hex.addEventListener('change', () => {
    const v = /^#?[0-9a-f]{6}$/i.test(hex.value) ? `#${hex.value.replace('#', '')}` : inp.value;
    inp.value = v;
    hex.value = v.toUpperCase();
    onStart?.();
    onInput?.(v);
    onChange?.(v);
  });
  const row = h('div', { class: 'ctl color' }, h('label', {}, label), h('div', { class: 'ctl-in' }, inp, hex));
  row.setValue = (v) => {
    inp.value = v;
    hex.value = v.toUpperCase();
  };
  return row;
}

export function toggleRow({ label, value, onChange, hint }) {
  const inp = h('input', { type: 'checkbox', checked: !!value });
  inp.addEventListener('change', () => onChange?.(inp.checked));
  const row = h('label', { class: 'ctl toggle', title: hint || '' }, h('span', { class: 'tlabel' }, label), h('span', { class: 'switch' }, inp, h('i')));
  row.setValue = (v) => (inp.checked = !!v);
  return row;
}

export function segmented({ options, value, onChange, small = false }) {
  const wrap = h('div', { class: `seg${small ? ' small' : ''}` });
  for (const o of options) {
    const b = h('button', { type: 'button', class: String(o.value) === String(value) ? 'on' : '', title: o.title || '' });
    if (o.icon) b.insertAdjacentHTML('beforeend', icon(o.icon, 15));
    if (o.label) b.append(h('span', {}, o.label));
    b.addEventListener('click', () => {
      for (const x of wrap.children) x.classList.remove('on');
      b.classList.add('on');
      onChange?.(o.value);
    });
    wrap.append(b);
  }
  return wrap;
}

const sectionState = new Map();
export function section(title, content, { open = true, id = title, extra = null } = {}) {
  const isOpen = sectionState.has(id) ? sectionState.get(id) : open;
  const sec = h('div', { class: `sec${isOpen ? ' open' : ''}` });
  const head = h('button', { class: 'sec-head', type: 'button' }, h('span', { class: 'chev', html: icon('chevronRight', 14) }), h('span', {}, title));
  if (extra) head.append(extra);
  head.addEventListener('click', (e) => {
    if (extra && extra.contains(e.target)) return;
    sec.classList.toggle('open');
    sectionState.set(id, sec.classList.contains('open'));
  });
  sec.append(head, h('div', { class: 'sec-body' }, content));
  return sec;
}

export function fmtBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
}

export function fmtEta(sec) {
  if (sec === null || !isFinite(sec)) return '—';
  sec = Math.round(sec);
  if (sec < 60) return `${sec} s`;
  const m = Math.floor(sec / 60);
  return `${m} min ${String(sec % 60).padStart(2, '0')} s`;
}

export const isMac = window.api?.platform === 'darwin';
export const modKey = isMac ? '⌘' : 'Ctrl';

export function isTypingTarget(el) {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'TEXTAREA' || el.isContentEditable) return true;
  if (tag === 'INPUT') return !['range', 'checkbox', 'radio', 'button', 'color'].includes(el.type);
  return tag === 'SELECT';
}

export function debounce(fn, ms) {
  let t = null;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

export function rafThrottle(fn) {
  let queued = false;
  let lastArgs;
  return (...a) => {
    lastArgs = a;
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      fn(...lastArgs);
    });
  };
}
