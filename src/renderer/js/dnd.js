// Arrastre en curso desde los paneles hacia la línea de tiempo.
export const dnd = { payload: null };

export function makeDraggable(el, payloadFn, label) {
  el.draggable = true;
  el.addEventListener('dragstart', (e) => {
    dnd.payload = payloadFn();
    e.dataTransfer.effectAllowed = 'copy';
    e.dataTransfer.setData('text/plain', label || dnd.payload?.type || 'litecut');
    document.body.classList.add('dnd-active');
  });
  el.addEventListener('dragend', () => {
    dnd.payload = null;
    document.body.classList.remove('dnd-active');
  });
}
