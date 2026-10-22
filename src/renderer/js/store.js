// Estado del editor: proyecto, selección e historial (deshacer/rehacer).
import { createProject, normalizeProject } from '../shared/model.js';
import { sanitizeProject, findClip, findTrack, findMedia } from '../shared/ops.js';

const MAX_HISTORY = 150;

export class Store extends EventTarget {
  constructor() {
    super();
    this.project = createProject();
    this.projectPath = null;
    this.dirty = false;
    this.selection = new Set();
    this.selectedTransition = null;
    this.selectedMediaId = null;
    this.undoStack = [];
    this.redoStack = [];
    this.pending = null;
    this.version = 0;
    this.clipboard = null;
  }

  on(type, fn) {
    const h = (e) => fn(e.detail);
    this.addEventListener(type, h);
    return () => this.removeEventListener(type, h);
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  // El historial guarda la línea de tiempo, los marcadores y los ajustes (no la biblioteca de medios).
  snapshot() {
    const p = this.project;
    return JSON.stringify({ name: p.name, settings: p.settings, tracks: p.tracks, clips: p.clips, markers: p.markers || [] });
  }

  applySnapshot(s) {
    const d = JSON.parse(s);
    this.project.name = d.name;
    this.project.settings = d.settings;
    this.project.tracks = d.tracks;
    this.project.clips = d.clips;
    this.project.markers = d.markers || [];
  }

  changed(kind = 'edit') {
    this.version++;
    this.setDirty(true);
    this.emit('change', { kind });
  }

  setDirty(v) {
    if (this.dirty === v) return;
    this.dirty = v;
    window.api.app.setDirty(v);
    this.emit('dirty', v);
  }

  pushUndo(before) {
    this.undoStack.push(before);
    if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  // Cambio con historial. fn recibe el proyecto y lo modifica.
  mutate(fn, { history = true } = {}) {
    if (this.pending) this.commitEdit();
    const before = history ? this.snapshot() : null;
    const result = fn(this.project);
    sanitizeProject(this.project);
    if (history && before !== this.snapshot()) this.pushUndo(before);
    this.pruneSelection();
    this.changed();
    return result;
  }

  // Cambios continuos (deslizadores, arrastres): beginEdit → live (muchas veces) → commitEdit.
  beginEdit() {
    if (!this.pending) this.pending = this.snapshot();
  }

  live(fn) {
    if (!this.pending) this.beginEdit();
    fn(this.project);
    this.version++;
    this.emit('change', { kind: 'live' });
  }

  commitEdit() {
    if (!this.pending) return;
    const before = this.pending;
    this.pending = null;
    sanitizeProject(this.project);
    if (before !== this.snapshot()) this.pushUndo(before);
    this.pruneSelection();
    this.changed();
  }

  cancelEdit() {
    if (!this.pending) return;
    this.applySnapshot(this.pending);
    this.pending = null;
    this.version++;
    this.emit('change', { kind: 'live' });
  }

  get canUndo() {
    return this.undoStack.length > 0;
  }

  get canRedo() {
    return this.redoStack.length > 0;
  }

  undo() {
    if (this.pending) this.commitEdit();
    const s = this.undoStack.pop();
    if (!s) return false;
    this.redoStack.push(this.snapshot());
    this.applySnapshot(s);
    this.pruneSelection();
    this.changed('undo');
    return true;
  }

  redo() {
    const s = this.redoStack.pop();
    if (!s) return false;
    this.undoStack.push(this.snapshot());
    this.applySnapshot(s);
    this.pruneSelection();
    this.changed('redo');
    return true;
  }

  // ---------- Selección ----------
  select(ids, { add = false, toggle = false } = {}) {
    if (!add && !toggle) this.selection.clear();
    this.selectedTransition = null;
    for (const id of ids) {
      if (toggle && this.selection.has(id)) this.selection.delete(id);
      else this.selection.add(id);
    }
    this.emit('selection');
  }

  clearSelection() {
    if (!this.selection.size && !this.selectedTransition) return;
    this.selection.clear();
    this.selectedTransition = null;
    this.emit('selection');
  }

  // Transición seleccionada (se identifica por el clip que entra).
  selectTransition(clipId) {
    this.selection.clear();
    this.selectedTransition = clipId || null;
    this.emit('selection');
  }

  pruneSelection() {
    let changed = false;
    for (const id of [...this.selection])
      if (!findClip(this.project, id)) {
        this.selection.delete(id);
        changed = true;
      }
    if (this.selectedTransition) {
      const c = findClip(this.project, this.selectedTransition);
      if (!c || !c.transitionIn) {
        this.selectedTransition = null;
        changed = true;
      }
    }
    if (changed) this.emit('selection');
  }

  get selectedClips() {
    return [...this.selection].map((id) => findClip(this.project, id)).filter(Boolean);
  }

  get singleSelected() {
    const s = this.selectedClips;
    return s.length === 1 ? s[0] : null;
  }

  // ---------- Medios (fuera del historial) ----------
  addMedia(m) {
    this.project.media.push(m);
    this.version++;
    this.setDirty(true);
    this.emit('media');
  }

  updateMedia(id, patch) {
    const m = findMedia(this.project, id);
    if (!m) return;
    Object.assign(m, patch);
    this.version++;
    this.emit('media', { id });
    this.emit('change', { kind: 'media' });
  }

  removeMedia(id) {
    this.project.media = this.project.media.filter((m) => m.id !== id);
    this.project.clips = this.project.clips.filter((c) => c.mediaId !== id);
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.pruneSelection();
    this.changed();
    this.emit('media');
  }

  // ---------- Proyecto ----------
  load(project, path = null) {
    this.project = normalizeProject(project);
    sanitizeProject(this.project);
    this.projectPath = path;
    this.undoStack = [];
    this.redoStack = [];
    this.pending = null;
    this.selection.clear();
    this.selectedTransition = null;
    this.selectedMediaId = null;
    this.version++;
    this.dirty = true;
    this.setDirty(false);
    this.emit('load');
    this.emit('media');
    this.emit('selection');
    this.emit('change', { kind: 'load' });
  }

  serialize() {
    const p = this.project;
    return JSON.stringify(
      {
        app: 'LiteCut Studio',
        version: p.version,
        name: p.name,
        settings: p.settings,
        media: p.media.map(({ id, path, name, kind, duration, width, height, hasAudio, hasVideo, fps, size, start, container, vcodec, acodec, proxyPath, proxyParts, reversedFrom }) => ({
          id,
          path,
          name,
          kind,
          duration,
          width,
          height,
          hasAudio,
          hasVideo,
          fps,
          size,
          start,
          container,
          vcodec,
          acodec,
          proxyPath,
          ...(proxyParts?.length ? { proxyParts } : {}),
          ...(reversedFrom ? { reversedFrom } : {}),
        })),
        tracks: p.tracks,
        clips: p.clips,
        markers: p.markers || [],
      },
      null,
      1
    );
  }

  getClip(id) {
    return findClip(this.project, id);
  }

  getTrack(id) {
    return findTrack(this.project, id);
  }

  getMedia(id) {
    return findMedia(this.project, id);
  }
}

export const store = new Store();
