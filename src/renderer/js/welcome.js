// Pantalla de bienvenida: nuevo proyecto por formato, proyectos recientes y recuperación.
import { h, btn } from './ui.js';
import { icon } from './icons.js';
import { ASPECTS } from '../shared/model.js';

const api = window.api;

export async function showWelcome({ onNew, onOpen, onOpenPath, onRecover, onRecord }) {
  const [recent, auto, info] = await Promise.all([api.project.recent(), api.project.loadAutosave(), api.app.info()]);
  const overlay = h('div', { class: 'welcome' });
  const close = () => {
    overlay.classList.add('out');
    setTimeout(() => overlay.remove(), 200);
  };
  const formats = h('div', { class: 'wl-formats' });
  for (const a of ASPECTS) {
    const ratio = a.w / a.h;
    const bw = ratio >= 1 ? 54 : 54 * ratio;
    const bh = ratio >= 1 ? 54 / ratio : 54;
    const card = h('button', { class: 'wl-format', type: 'button' }, h('span', { class: 'wl-box-wrap' }, h('span', { class: 'wl-box', style: { width: `${bw}px`, height: `${bh}px` } })), h('b', {}, a.label), h('span', {}, a.sub));
    card.addEventListener('click', () => {
      close();
      onNew(a.id);
    });
    formats.append(card);
  }
  const recentList = h('div', { class: 'wl-recent' });
  if (recent.length) {
    for (const r of recent.slice(0, 8)) {
      const row = h('button', { class: 'wl-recent-row', type: 'button', title: r.path }, h('span', { html: icon('film', 16) }), h('span', { class: 'wl-r-txt' }, h('b', {}, r.name.replace(/\.lcproj$/i, '')), h('small', {}, r.path)));
      row.addEventListener('click', () => {
        close();
        onOpenPath(r.path);
      });
      recentList.append(row);
    }
  } else {
    recentList.append(h('p', { class: 'hint' }, 'Aquí aparecerán tus proyectos recientes.'));
  }
  const recover = auto
    ? h(
        'div',
        { class: 'wl-recover' },
        h('span', { html: icon('alert', 18) }),
        h('div', {}, h('b', {}, 'Hay un proyecto sin guardar'), h('small', {}, `«${auto.meta.name || 'Proyecto'}» · ${new Date(auto.meta.time).toLocaleString()}`)),
        btn('Recuperar', {
          kind: 'small primary',
          onClick: () => {
            close();
            onRecover(auto);
          },
        })
      )
    : null;
  overlay.append(
    h(
      'div',
      { class: 'wl-card' },
      h(
        'div',
        { class: 'wl-left' },
        h('div', { class: 'wl-logo' }, h('span', { class: 'logo-mark', html: icon('logo', 34) }), h('div', {}, h('h1', {}, 'LiteCut Studio'), h('span', {}, 'Editor de video liviano + grabador de pantalla'))),
        recover,
        h('h2', {}, 'Nuevo proyecto'),
        formats,
        h(
          'div',
          { class: 'wl-actions' },
          btn('Abrir proyecto…', {
            icon: 'folder',
            onClick: async () => {
              const ok = await onOpen();
              if (ok) close();
            },
          }),
          btn('Grabar pantalla', {
            kind: 'rec-btn',
            icon: 'record',
            onClick: () => {
              close();
              onNew('16:9');
              onRecord();
            },
          })
        )
      ),
      h('div', { class: 'wl-right' }, h('h2', {}, 'Recientes'), recentList, h('div', { class: 'wl-foot' }, `Versión ${info.version} · ${info.platform === 'darwin' ? 'macOS' : info.platform === 'win32' ? 'Windows' : info.platform}`))
    )
  );
  document.body.append(overlay);
  return { close, hasRecovery: !!auto, isOpen: () => overlay.isConnected };
}
