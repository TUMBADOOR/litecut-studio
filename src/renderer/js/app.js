// Punto de entrada de la interfaz: arma el editor y conecta menús, atajos y archivos.
import { store } from './store.js';
import { media } from './media.js';
import * as edit from './edit.js';
import { Viewer } from './viewer.js';
import { Timeline } from './timeline.js';
import { Inspector } from './inspector.js';
import { Panels } from './panels.js';
import { openExportDialog } from './export-dialog.js';
import { openRecorderDialog } from './recorder-dialog.js';
import { openVoiceover } from './voiceover.js';
import { showWelcome } from './welcome.js';
import { initAiCommands, runQueued } from './ai-commands.js';
import { openAiDialog, clientLabel } from './ai-dialog.js';
import { h, $, toast, modal, choiceDialog, alertDialog, isTypingTarget, closeTopModal, hasOpenModal, modKey, btn, iconBtn, contextMenu, closeContextMenu, isMac } from './ui.js';
import { icon } from './icons.js';
import { createProject, clipEnd, ASPECTS, isVisual, createClip } from '../shared/model.js';
import * as ops from '../shared/ops.js';
import { FONTS, ensureFont } from './text-render.js';

const api = window.api;
document.body.classList.add(isMac ? 'mac' : 'win');

// ---------- Barra superior ----------
const nameInput = h('input', { class: 'proj-name', value: store.project.name, title: 'Nombre del proyecto', spellcheck: 'false' });
const dirtyDot = h('span', { class: 'dirty-dot', title: 'Cambios sin guardar' });
nameInput.addEventListener('change', () => store.mutate((p) => (p.name = nameInput.value.trim() || 'Proyecto sin título')));
nameInput.addEventListener('keydown', (e) => e.key === 'Enter' && nameInput.blur());
const aiBtn = btn('IA', { kind: 'small ghost ai-btn', icon: 'sparkles', title: 'Conectar con IA (Claude, Gemini…)', onClick: () => openAi() });
// «Conectar con IA» (apps de escritorio por MCP) ofrece también el asistente integrado, para quien no tiene una.
const openAi = () => openAiDialog({ onOpenAssistant: () => panels.show('assistant') });
$('#topbar').append(
  h('div', { class: 'brand' }, h('span', { class: 'logo-mark', html: icon('logo', 26) }), h('b', {}, 'LiteCut'), h('span', {}, 'Studio')),
  h(
    'div',
    { class: 'tb-group' },
    btn('Nuevo', { kind: 'ghost small', icon: 'plus', title: `Nuevo proyecto (${modKey}+N)`, onClick: () => newProjectFlow() }),
    btn('Abrir', { kind: 'ghost small', icon: 'folder', title: `Abrir proyecto (${modKey}+O)`, onClick: () => openProjectDialog() }),
    btn('Guardar', { kind: 'ghost small', icon: 'save', title: `Guardar (${modKey}+S)`, onClick: () => saveProject(false) })
  ),
  h('div', { class: 'tb-center' }, nameInput, dirtyDot),
  h(
    'div',
    { class: 'tb-right' },
    aiBtn,
    btn('Importar', { kind: 'small', icon: 'import', title: `Importar medios (${modKey}+I)`, onClick: () => importMedia() }),
    btn('Grabar', { kind: 'small rec-btn', icon: 'record', title: `Grabar pantalla (${modKey}+Mayús+R)`, onClick: () => openRecorder() }),
    btn('Exportar', { kind: 'small primary', icon: 'export', title: `Exportar video (${modKey}+E)`, onClick: () => openExport() }),
    iconBtn('dots', 'Más opciones', (e) => {
      const r = e.currentTarget.getBoundingClientRect();
      contextMenu(r.right - 230, r.bottom + 4, [
        { label: 'Guardar como…', icon: 'save', shortcut: `${modKey}+Mayús+S`, onClick: () => saveProject(true) },
        { label: 'Grabar voz en off', icon: 'mic', onClick: () => openVoice() },
        { label: 'Carpeta de grabaciones', icon: 'folder', onClick: () => api.shell.openRecordings() },
        { label: 'Asistente de IA', icon: 'chat', onClick: () => panels.show('assistant') },
        { label: 'Conectar con IA…', icon: 'sparkles', onClick: () => openAi() },
        'sep',
        { label: 'Atajos de teclado', icon: 'keyboard', shortcut: 'F1', onClick: () => showShortcuts() },
        { label: 'Acerca de LiteCut Studio', icon: 'info', onClick: () => showAbout() },
      ]);
    })
  )
);

// ---------- Componentes ----------
const viewer = new Viewer($('#viewer'));
const player = viewer.player;
edit.setPlayer(player);
const timeline = new Timeline($('#timeline'), viewer);
const inspector = new Inspector($('#inspector'), { player, onShortcuts: () => showShortcuts() });
const panels = new Panels($('#sidetabs'), $('#panel'), {
  importMedia: (kind) => importMedia(kind),
  openRecorder: () => openRecorder(),
  openVoiceover: () => openVoice(),
  openAiDialog: () => openAi(),
});
viewer.onSnapshot = () => saveSnapshot();
timeline.onFilesDropped = async (files, at) => {
  const added = await media.importPaths(files);
  let start = at.start;
  for (const m of added) {
    const c = edit.addMediaClip(m.id, { start, trackId: at.trackId });
    if (c) start = clipEnd(c);
  }
};
window.__app = {
  store,
  media,
  edit,
  player,
  viewer,
  timeline,
  inspector,
  panels,
  ops,
  openExport: () => openExport(),
  openProjectPath: (p) => openProjectPath(p, { skipConfirm: true }),
  saveProject: (asNew) => saveProject(asNew),
  ai: (name, args) => runQueued(name, args),
};

// ---------- Proyectos ----------
function updateTitle() {
  const name = store.project.name || 'Proyecto sin título';
  api.app.setTitle(`${name}${store.dirty ? ' •' : ''} — LiteCut Studio`);
  dirtyDot.classList.toggle('on', store.dirty);
  if (document.activeElement !== nameInput) nameInput.value = name;
}
store.on('dirty', updateTitle);
store.on('change', updateTitle);

async function confirmDiscard() {
  if (!store.dirty || !store.project.clips.length) return true;
  const r = await choiceDialog({
    title: 'Cambios sin guardar',
    message: `¿Quieres guardar los cambios de «${store.project.name}»?`,
    choices: [
      { id: 'cancel', label: 'Cancelar' },
      { id: 'discard', label: 'No guardar' },
      { id: 'save', label: 'Guardar', kind: 'primary' },
    ],
  });
  if (r === 'save') return saveProject(false);
  return r === 'discard';
}

function newProject(aspect = '16:9') {
  player.pause();
  store.load(createProject(aspect));
  api.project.clearAutosave();
  updateTitle();
}

async function newProjectFlow() {
  if (!(await confirmDiscard())) return;
  showWelcome(welcomeHandlers({ skipConfirm: true }));
}

async function openProjectDialog() {
  if (!(await confirmDiscard())) return false;
  const path = await api.dialog.openProject();
  if (!path) return false;
  return openProjectPath(path, { skipConfirm: true });
}

async function openProjectPath(path, { skipConfirm = false } = {}) {
  if (!skipConfirm && !(await confirmDiscard())) return false;
  try {
    const data = JSON.parse(await api.project.read(path));
    if (!data || !Array.isArray(data.clips) || !Array.isArray(data.media)) throw new Error('El archivo no es un proyecto de LiteCut Studio válido.');
    player.pause();
    store.load(data, path);
    api.project.addRecent(path, store.project.name);
    await media.prepareAll();
    updateTitle();
    const missing = store.project.media.filter((m) => m.missing).length;
    if (missing) toast(`${missing} archivo(s) no se encontraron. Haz clic derecho sobre ellos en Medios › «Buscar archivo…»`, { type: 'error', timeout: 8000 });
    else toast(`Proyecto «${store.project.name}» abierto`, { timeout: 1800 });
    return true;
  } catch (err) {
    alertDialog('No se pudo abrir el proyecto', err.message);
    return false;
  }
}

async function saveProject(saveAs) {
  let path = store.projectPath;
  if (!path || saveAs) {
    path = await api.dialog.saveProject(store.project.name);
    if (!path) return false;
    if (store.project.name === 'Proyecto sin título') {
      const base = path.split(/[\\/]/).pop().replace(/\.lcproj$/i, '');
      store.project.name = base;
    }
  }
  try {
    await api.project.write(path, store.serialize());
    store.projectPath = path;
    store.setDirty(false);
    api.project.addRecent(path, store.project.name);
    api.project.clearAutosave();
    updateTitle();
    toast('Proyecto guardado', { timeout: 1500 });
    return true;
  } catch (err) {
    alertDialog('No se pudo guardar el proyecto', err.message);
    return false;
  }
}

async function recoverAutosave(auto) {
  try {
    const data = JSON.parse(auto.text);
    store.load(data, auto.meta.projectPath || null);
    store.setDirty(true);
    await media.prepareAll();
    updateTitle();
    toast('Proyecto recuperado. Guárdalo para no perderlo.', { timeout: 4000 });
  } catch (err) {
    alertDialog('No se pudo recuperar', err.message);
  }
}

function welcomeHandlers({ skipConfirm = false } = {}) {
  return {
    onNew: (aspect) => newProject(aspect),
    onOpen: () => (skipConfirm ? openProjectDialogNoConfirm() : openProjectDialog()),
    onOpenPath: (p) => openProjectPath(p, { skipConfirm: true }),
    onRecover: (auto) => recoverAutosave(auto),
    onRecord: () => openRecorder(),
  };
}

async function openProjectDialogNoConfirm() {
  const path = await api.dialog.openProject();
  if (!path) return false;
  return openProjectPath(path, { skipConfirm: true });
}

// ---------- Acciones ----------
async function importMedia(kind) {
  const paths = await api.dialog.openMedia(kind);
  if (!paths?.length) return;
  panels.show(kind === 'audio' ? 'audio' : 'media');
  const added = await media.importPaths(paths);
  if (added.length) toast(added.length === 1 ? `«${added[0].name}» importado` : `${added.length} archivos importados`, { timeout: 1800 });
}

function openRecorder() {
  player.pause();
  openRecorderDialog();
}

function openVoice() {
  openVoiceover({ player });
}

function openExport() {
  openExportDialog({ player });
}

async function saveSnapshot() {
  if (!store.project.clips.length) return;
  const canvas = await player.renderStill(1);
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
  const path = await api.dialog.saveImage(`${store.project.name} - fotograma`);
  if (!path) return;
  await api.fs.writeBinary(path, await blob.arrayBuffer());
  toast('Fotograma guardado', { actions: [{ label: 'Mostrar', onClick: () => api.shell.showItem(path) }] });
}

// Sugerir adaptar el lienzo al primer video/foto si su formato es distinto.
let suggested = false;
store.on('change', () => {
  if (suggested) return;
  const visual = store.project.clips.filter(isVisual);
  if (visual.length !== 1 || !visual[0].mediaId) return;
  const m = store.getMedia(visual[0].mediaId);
  if (!m || !m.width || !m.height) return;
  suggested = true;
  const s = store.project.settings;
  const ar = m.width / m.height;
  if (Math.abs(ar - s.width / s.height) / ar < 0.03) return;
  const preset = ASPECTS.find((a) => Math.abs(a.w / a.h - ar) / ar < 0.03);
  const W = preset ? preset.w : ar >= 1 ? Math.round((1080 * ar) / 2) * 2 : 1080;
  const H = preset ? preset.h : ar >= 1 ? 1080 : Math.round(1080 / ar / 2) * 2;
  const clipId = visual[0].id;
  toast(`Tu video es ${preset ? preset.label : `${m.width}×${m.height}`} y el lienzo ${s.aspect}. ¿Ajustar el lienzo o rellenar las barras?`, {
    timeout: 10000,
    actions: [
      {
        label: 'Ajustar lienzo',
        onClick: () =>
          store.mutate((p) => {
            p.settings.width = W;
            p.settings.height = H;
            p.settings.aspect = preset ? preset.id : 'custom';
          }),
      },
      {
        label: 'Fondo desenfocado',
        onClick: () =>
          store.mutate((p) => {
            const c = ops.findClip(p, clipId);
            if (c && (c.type === 'video' || c.type === 'image')) c.bgFill = 'blur';
          }),
      },
    ],
  });
});
store.on('load', () => {
  suggested = store.project.clips.some(isVisual);
});

// ---------- Grabación terminada ----------
let procBanner = null;
api.rec.onProcessing(({ progress }) => {
  if (!procBanner) {
    procBanner = h('div', { class: 'proc-banner' }, h('span', { class: 'spinner' }), h('span', { class: 'txt' }, 'Procesando grabación…'));
    document.body.append(procBanner);
  }
  procBanner.querySelector('.txt').textContent = `Procesando grabación… ${Math.round((progress || 0) * 100)}%`;
});

api.rec.onFinished(async (r) => {
  procBanner?.remove();
  procBanner = null;
  if (r.cancelled) {
    toast('Grabación descartada', { timeout: 2000 });
    return;
  }
  if (r.error) {
    alertDialog('No se pudo completar la grabación', 'Ocurrió un problema al grabar o procesar el video.', r.error);
    return;
  }
  if (r.warning) toast(r.warning, { timeout: 7000 });
  if (r.mode === 'save') {
    toast('Grabación guardada en Videos › LiteCut Studio', {
      timeout: 9000,
      actions: [
        { label: 'Mostrar', onClick: () => api.shell.showItem(r.screen) },
        { label: 'Editar', onClick: () => addRecordingToProject({ ...r, region: null }) },
      ],
    });
    return;
  }
  await addRecordingToProject(r);
});

async function addRecordingToProject(r) {
  const paths = [r.screen, r.webcam].filter(Boolean);
  const added = await media.importPaths(paths);
  const screenM = added.find((m) => m.path === r.screen);
  const camM = r.webcam ? added.find((m) => m.path === r.webcam) : null;
  if (!screenM) return;
  const wasEmpty = store.project.clips.length === 0;
  suggested = true;
  let clipId = null;
  store.mutate((p) => {
    const reg = r.region;
    if (wasEmpty) {
      let W = reg ? screenM.width * reg.w : screenM.width;
      let H = reg ? screenM.height * reg.h : screenM.height;
      const k = Math.min(1, 3840 / Math.max(W, H));
      W = Math.max(128, Math.round((W * k) / 2) * 2);
      H = Math.max(128, Math.round((H * k) / 2) * 2);
      const preset = ASPECTS.find((a) => a.w === W && a.h === H);
      p.settings.width = W;
      p.settings.height = H;
      p.settings.aspect = preset ? preset.id : 'custom';
    }
    const c = ops.addMediaClip(p, screenM, {});
    clipId = c.id;
    if (reg) c.crop = { l: reg.x, t: reg.y, r: Math.max(0, 1 - reg.x - reg.w), b: Math.max(0, 1 - reg.y - reg.h) };
    if (camM) {
      const PW = p.settings.width;
      const PH = p.settings.height;
      const tr = ops.findFreeTrack(p, 'video', c.start, clipEnd(c));
      const cam = createClip('video', { mediaId: camM.id, name: 'Cámara', trackId: tr.id, start: c.start, duration: Math.min(camM.duration || c.duration, c.duration) });
      if (camM.width >= camM.height) {
        const f = (1 - camM.height / camM.width) / 2;
        cam.crop = { l: f, r: f, t: 0, b: 0 };
      } else {
        const f = (1 - camM.width / camM.height) / 2;
        cam.crop = { l: 0, r: 0, t: f, b: f };
      }
      cam.mask = 'circle';
      const base = Math.min(PW, PH);
      const size = base * 0.28;
      cam.transform.scale = Math.round((size / base) * 1000) / 1000;
      const margin = base * 0.04;
      cam.transform.x = Math.round(PW / 2 - size / 2 - margin);
      cam.transform.y = Math.round(PH / 2 - size / 2 - margin);
      p.clips.push(cam);
    }
  });
  if (clipId) store.select([clipId]);
  timeline.fitZoom();
  toast(camM ? 'Grabación añadida (la cámara está en su propia pista)' : 'Grabación añadida a la línea de tiempo', { timeout: 3500 });
}

// ---------- Menú y teclado ----------
api.app.onMenu((cmd) => {
  // En el chat del asistente vacío, Ctrl+Z deshace lo último del proyecto (lo que acaba de hacer la IA).
  const el = document.activeElement;
  const typing = isTypingTarget(el) && !(el.classList.contains('asst-input') && !el.value);
  closeContextMenu();
  switch (cmd) {
    case 'new':
      return newProjectFlow();
    case 'open':
      return openProjectDialog();
    case 'save':
      return saveProject(false);
    case 'saveAs':
      return saveProject(true);
    case 'import':
      return importMedia();
    case 'record':
      return openRecorder();
    case 'voiceover':
      return openVoice();
    case 'export':
      return openExport();
    case 'ai':
      return openAi();
    case 'assistant':
      return panels.show('assistant');
    case 'undo':
      if (typing) document.execCommand('undo');
      else store.undo();
      return;
    case 'redo':
      if (typing) document.execCommand('redo');
      else store.redo();
      return;
    case 'selectAll':
      if (typing) document.execCommand('selectAll');
      else edit.selectAll();
      return;
    case 'split':
      if (!typing) edit.splitAtPlayhead();
      return;
    case 'duplicate':
      if (!typing) edit.duplicateSelected();
      return;
    case 'delete':
      if (!typing) edit.deleteSelected(false);
      return;
    case 'rippleDelete':
      if (!typing) edit.deleteSelected(true);
      return;
    case 'zoomIn':
      return timeline.zoomBy(1.5);
    case 'zoomOut':
      return timeline.zoomBy(1 / 1.5);
    case 'zoomFit':
      return timeline.fitZoom();
    case 'shortcuts':
      return showShortcuts();
    case 'about':
      return showAbout();
    default:
      return undefined;
  }
});

function editPoints() {
  const pts = new Set([0, player.duration]);
  for (const c of store.project.clips) {
    pts.add(c.start);
    pts.add(clipEnd(c));
  }
  return [...pts].sort((a, b) => a - b);
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeContextMenu();
    if (closeTopModal()) return;
    if (!isTypingTarget(e.target)) store.clearSelection();
    return;
  }
  if (e.key === 'F1') {
    e.preventDefault();
    showShortcuts();
    return;
  }
  if (hasOpenModal() || isTypingTarget(e.target) || document.querySelector('.welcome')) return;
  const mod = e.ctrlKey || e.metaKey;
  const fps = store.project.settings.fps;
  switch (e.key) {
    case ' ':
      e.preventDefault();
      // Evita que la barra espaciadora además "pulse" el último botón usado.
      if (document.activeElement && document.activeElement.tagName === 'BUTTON') document.activeElement.blur();
      if (!e.repeat) player.toggle();
      break;
    case 's':
    case 'S':
      if (!mod && !e.altKey) {
        e.preventDefault();
        edit.splitAtPlayhead();
      }
      break;
    case 'Delete':
    case 'Backspace':
      e.preventDefault();
      edit.deleteSelected(e.shiftKey);
      break;
    case 'ArrowLeft':
    case 'ArrowRight': {
      e.preventDefault();
      const dir = e.key === 'ArrowLeft' ? -1 : 1;
      if (e.altKey) edit.nudgeSelected((dir * (e.shiftKey ? fps : 1)) / fps);
      else player.step(dir * (e.shiftKey ? fps : 1));
      break;
    }
    case 'ArrowUp':
    case 'ArrowDown': {
      e.preventDefault();
      const pts = editPoints();
      const t = player.time;
      const next = e.key === 'ArrowDown' ? pts.find((x) => x > t + 1e-3) : [...pts].reverse().find((x) => x < t - 1e-3);
      if (next !== undefined) player.seek(next);
      break;
    }
    case 'Home':
      e.preventDefault();
      player.seek(0);
      break;
    case 'End':
      e.preventDefault();
      player.seek(player.duration);
      break;
    case '+':
    case '=':
      if (!mod) timeline.zoomBy(1.5);
      break;
    case '-':
    case '_':
      if (!mod) timeline.zoomBy(1 / 1.5);
      break;
    case 'z':
    case 'Z':
      if (e.shiftKey && !mod) timeline.fitZoom();
      break;
    case 'n':
    case 'N':
      if (!mod) timeline.toggleSnap();
      break;
    case 't':
    case 'T':
      if (!mod) edit.addText('title');
      break;
    default:
      break;
  }
});

document.addEventListener('copy', (e) => {
  if (isTypingTarget(document.activeElement)) return;
  if (edit.copySelected()) e.preventDefault();
});
document.addEventListener('cut', (e) => {
  if (isTypingTarget(document.activeElement)) return;
  e.preventDefault();
  edit.cutSelected();
});
document.addEventListener('paste', (e) => {
  if (isTypingTarget(document.activeElement)) return;
  e.preventDefault();
  const files = [...(e.clipboardData?.files || [])].map((f) => api.getPathForFile(f)).filter(Boolean);
  if (files.length) media.importPaths(files);
  else edit.paste();
});

// Arrastrar archivos desde el explorador a la ventana.
window.addEventListener('dragover', (e) => {
  if (e.dataTransfer?.types?.includes('Files')) {
    e.preventDefault();
    document.body.classList.add('drop-files');
  }
});
window.addEventListener('dragleave', (e) => {
  if (!e.relatedTarget) document.body.classList.remove('drop-files');
});
window.addEventListener('drop', async (e) => {
  document.body.classList.remove('drop-files');
  if (!e.dataTransfer?.files?.length) return;
  e.preventDefault();
  const paths = [...e.dataTransfer.files].map((f) => api.getPathForFile(f)).filter(Boolean);
  const proj = paths.find((p) => /\.lcproj$/i.test(p));
  if (proj) {
    openProjectPath(proj);
    return;
  }
  panels.show('media');
  const added = await media.importPaths(paths);
  if (added.length) toast(`${added.length} archivo(s) importado(s)`, { timeout: 1800 });
});

// ---------- Divisor entre el editor y la línea de tiempo ----------
{
  const split = $('#hsplit');
  const saved = parseInt(localStorage.getItem('litecut.tlh') || '0', 10);
  if (saved) document.documentElement.style.setProperty('--tl-h', `${saved}px`);
  split.addEventListener('pointerdown', (e) => {
    const y0 = e.clientY;
    const h0 = $('#timeline').getBoundingClientRect().height;
    try {
      split.setPointerCapture(e.pointerId);
    } catch {
      /* puntero sintético */
    }
    const move = (ev) => {
      const nh = Math.max(170, Math.min(window.innerHeight - 320, h0 - (ev.clientY - y0)));
      document.documentElement.style.setProperty('--tl-h', `${nh}px`);
    };
    const up = () => {
      split.removeEventListener('pointermove', move);
      split.removeEventListener('pointerup', up);
      localStorage.setItem('litecut.tlh', String(Math.round($('#timeline').getBoundingClientRect().height)));
      viewer.layout();
    };
    split.addEventListener('pointermove', move);
    split.addEventListener('pointerup', up);
  });
}

// ---------- Autoguardado y cierre ----------
setInterval(() => {
  if (store.dirty && store.project.clips.length) api.project.autosave(store.serialize(), { name: store.project.name, projectPath: store.projectPath });
}, 45000);

api.app.onRequestClose(async () => {
  const r = await choiceDialog({
    title: 'Salir de LiteCut Studio',
    message: 'Hay cambios sin guardar. ¿Quieres guardarlos antes de salir?',
    choices: [
      { id: 'cancel', label: 'Cancelar' },
      { id: 'discard', label: 'Salir sin guardar' },
      { id: 'save', label: 'Guardar y salir', kind: 'primary' },
    ],
  });
  if (r === 'save') {
    if (await saveProject(false)) api.app.forceClose();
  } else if (r === 'discard') {
    await api.project.clearAutosave();
    api.app.forceClose();
  }
});

// ---------- Ayuda ----------
function showShortcuts() {
  const rows = [
    ['Espacio', 'Reproducir / pausar'],
    ['S', 'Dividir clip en el cursor'],
    ['Supr', 'Eliminar selección'],
    ['Mayús + Supr', 'Eliminar y cerrar hueco'],
    [`${modKey} + Z / ${modKey} + Y`, 'Deshacer / rehacer'],
    [`${modKey} + C / V / D`, 'Copiar / pegar / duplicar'],
    [`${modKey} + A`, 'Seleccionar todo'],
    ['← / →', 'Fotograma anterior / siguiente'],
    ['Mayús + ← / →', 'Retroceder / avanzar 1 segundo'],
    ['Alt + ← / →', 'Mover los clips seleccionados'],
    ['↑ / ↓', 'Saltar al corte anterior / siguiente'],
    ['Inicio / Fin', 'Ir al principio / al final'],
    ['+ / −', 'Acercar / alejar la línea de tiempo'],
    ['Mayús + Z', 'Ajustar la línea de tiempo a la ventana'],
    ['N', 'Activar / desactivar el imán'],
    ['T', 'Añadir texto'],
    [`${modKey} + Rueda`, 'Zoom en la línea de tiempo'],
    ['Alt (al arrastrar)', 'Mover sin imán'],
    [`${modKey} + S`, 'Guardar proyecto'],
    [`${modKey} + E`, 'Exportar'],
    [`${modKey} + Mayús + R`, 'Grabar pantalla'],
    [`${modKey} + Alt + S`, 'Detener la grabación'],
    [`${modKey} + Alt + P`, 'Pausar / reanudar la grabación'],
  ];
  const table = h('div', { class: 'shortcuts' }, ...rows.map(([k, d]) => h('div', { class: 'sc-row' }, h('kbd', {}, k), h('span', {}, d))));
  modal({ title: 'Atajos de teclado', body: table, width: 560 });
}

async function showAbout() {
  const info = await api.app.info();
  modal({
    title: 'Acerca de LiteCut Studio',
    width: 500,
    body: h(
      'div',
      { class: 'about' },
      h('div', { class: 'wl-logo' }, h('span', { class: 'logo-mark', html: icon('logo', 40) }), h('div', {}, h('h1', {}, 'LiteCut Studio'), h('span', {}, `Versión ${info.version} · ${info.platform === 'darwin' ? 'macOS' : 'Windows'} ${info.arch}`))),
      h('p', {}, 'Editor de video liviano con grabador de pantalla. Hecho con Electron y FFmpeg.'),
      h('p', { class: 'hint' }, `Motor de video: ${info.ffmpeg}`),
      h('p', { class: 'hint' }, 'Este programa incluye FFmpeg (licencia GPL/LGPL, ffmpeg.org) y fuentes tipográficas con licencia SIL Open Font License.')
    ),
  });
}

// ---------- Inicio ----------
let welcome = null;
let openedFromFile = false;
api.app.onOpenProject((p) => {
  openedFromFile = true;
  welcome?.close();
  openProjectPath(p, { skipConfirm: !store.dirty });
});

// Carga en segundo plano las fuentes incluidas (para que los textos se vean bien desde el principio).
setTimeout(() => {
  for (const f of FONTS.filter((x) => !x.system)) for (const w of f.weights) ensureFont({ font: f.family, weight: w, italic: false, content: 'Aa' });
}, 1500);

updateTitle();
if (!api.isTest) {
  showWelcome(welcomeHandlers()).then((w) => {
    welcome = w;
    if (openedFromFile) w.close();
  });
}

// ---------- Asistentes de IA (servidor MCP local y asistente integrado) ----------
const aiPill = h('div', { class: 'ai-activity' }, h('span', { class: 'spinner' }), h('span', { class: 'txt' }));
document.body.append(aiPill);
let aiPillTimer = null;

function updateAiButton(s) {
  aiBtn.classList.toggle('ready', !!s.enabled);
  aiBtn.classList.toggle('linked', !!s.enabled && s.clients.length > 0);
  const names = [...new Set(s.clients.map((c) => clientLabel(c.title || c.name)))];
  aiBtn.title = !s.enabled ? 'Conectar con IA (Claude, Gemini…)' : names.length ? `IA conectada: ${names.join(', ')}` : 'Conexión con IA activada: esperando a tu app de IA';
}
api.ai.onStatus(updateAiButton);
api.ai.status().then(updateAiButton);

initAiCommands({
  player,
  timeline,
  // Antes de que la IA cambie el proyecto: se cierra la bienvenida (salvo que haya algo que recuperar).
  beforeEdit: () => {
    if (welcome?.isOpen()) {
      if (welcome.hasRecovery) throw new Error('LiteCut muestra la pantalla de inicio con un proyecto sin guardar que se puede recuperar. Pide al usuario que elija «Recuperar» o un formato de proyecto nuevo, y vuelve a intentarlo.');
      welcome.close();
    }
    suggested = true; // la IA decide el lienzo: no se sugiere ajustarlo
  },
  onActivity: ({ state, title, client, error }) => {
    clearTimeout(aiPillTimer);
    // El asistente integrado ya muestra cada paso en su panel: el aviso solo hace falta si está en otra pestaña.
    if (client === 'Asistente' && panels.tab === 'assistant') {
      aiPill.classList.remove('on');
      return;
    }
    aiPill.classList.add('on');
    aiPill.classList.toggle('busy', state === 'start');
    aiPill.classList.toggle('err', state === 'done' && !!error);
    const who = client ? clientLabel(client) : 'IA';
    aiPill.querySelector('.txt').textContent = `${who} · ${title}${state === 'start' ? '…' : error ? ': no se pudo' : ' ✓'}`;
    if (state === 'done') aiPillTimer = setTimeout(() => aiPill.classList.remove('on'), 2600);
  },
  onSaved: () => updateTitle(),
});
