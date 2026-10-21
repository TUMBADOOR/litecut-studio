// Selección del área de grabación (modo "select") y marco visible durante la grabación (modo "frame").
const api = window.api;
const mode = new URLSearchParams(location.search).get('mode');
const $ = (id) => document.getElementById(id);

if (mode === 'frame') {
  document.body.className = 'frame';
} else {
  document.body.className = 'select';
  const sel = $('sel');
  const size = $('size');
  const actions = $('actions');
  let start = null;
  let rect = null;
  const dpr = window.devicePixelRatio || 1;

  const draw = () => {
    if (!rect) {
      sel.hidden = true;
      document.body.classList.remove('has-sel');
      return;
    }
    sel.hidden = false;
    document.body.classList.add('has-sel');
    Object.assign(sel.style, { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.w}px`, height: `${rect.h}px` });
    size.textContent = `${Math.round(rect.w * dpr)} × ${Math.round(rect.h * dpr)}`;
  };

  const placeActions = () => {
    actions.hidden = false;
    const ah = 44;
    let top = rect.y + rect.h + 10;
    if (top + ah > window.innerHeight) top = Math.max(8, rect.y - ah - 10);
    if (top < 0 || rect.h > window.innerHeight - 120) top = rect.y + rect.h - ah - 12;
    actions.style.top = `${top}px`;
    actions.style.left = `${Math.max(8, Math.min(window.innerWidth - 260, rect.x + rect.w / 2 - 125))}px`;
  };

  const confirmSel = () => {
    if (!rect || rect.w < 16 || rect.h < 16) return;
    api.region.done({ x: rect.x, y: rect.y, w: rect.w, h: rect.h });
  };
  const cancel = () => api.region.done(null);

  document.addEventListener('pointerdown', (e) => {
    if (e.target.closest('#actions')) return;
    start = { x: e.clientX, y: e.clientY };
    rect = null;
    actions.hidden = true;
    try {
      document.body.setPointerCapture(e.pointerId);
    } catch {
      /* sin captura: los eventos siguen llegando al documento */
    }
    draw();
  });
  document.addEventListener('pointermove', (e) => {
    if (!start) return;
    const x = Math.max(0, Math.min(start.x, e.clientX));
    const y = Math.max(0, Math.min(start.y, e.clientY));
    const x2 = Math.min(window.innerWidth, Math.max(start.x, e.clientX));
    const y2 = Math.min(window.innerHeight, Math.max(start.y, e.clientY));
    // Dimensiones pares en píxeles físicos (lo exige el codificador de video).
    const w = Math.floor(((x2 - x) * dpr) / 2) * 2 / dpr;
    const h = Math.floor(((y2 - y) * dpr) / 2) * 2 / dpr;
    rect = { x, y, w, h };
    draw();
  });
  document.addEventListener('pointerup', () => {
    if (!start) return;
    start = null;
    if (rect && rect.w >= 16 && rect.h >= 16) placeActions();
    else {
      rect = null;
      draw();
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') cancel();
    if (e.key === 'Enter') confirmSel();
  });
  $('ok').addEventListener('click', confirmSel);
  $('cancel').addEventListener('click', cancel);
}
