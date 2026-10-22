// Puente seguro entre la interfaz y el proceso principal.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const invoke = (ch, ...a) => ipcRenderer.invoke(ch, ...a);
const on = (ch, cb) => {
  const h = (_e, ...a) => cb(...a);
  ipcRenderer.on(ch, h);
  return () => ipcRenderer.removeListener(ch, h);
};

const isTest = process.argv.includes('--litecut-test');

contextBridge.exposeInMainWorld('api', {
  platform: process.platform,
  isTest,
  getPathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return null;
    }
  },
  mediaUrl: (p) => `media://local/${encodeURIComponent(p)}`,

  app: {
    info: () => invoke('app:info'),
    setDirty: (v) => ipcRenderer.send('win:dirty', !!v),
    setTitle: (t) => ipcRenderer.send('win:title', t),
    forceClose: () => ipcRenderer.send('win:forceClose'),
    onMenu: (cb) => on('menu', cb),
    onRequestClose: (cb) => on('app:request-close', cb),
    onOpenProject: (cb) => on('app:open-project', cb),
    getPrefs: () => invoke('prefs:get'),
    setPrefs: (p) => invoke('prefs:set', p),
  },
  dialog: {
    openMedia: (kind) => invoke('dialog:openMedia', kind),
    openFile: (opts) => invoke('dialog:openFile', opts),
    openProject: () => invoke('dialog:openProject'),
    saveProject: (name) => invoke('dialog:saveProject', name),
    exportPath: (opts) => invoke('dialog:exportPath', opts),
    saveImage: (name) => invoke('dialog:saveImage', name),
  },
  project: {
    read: (file) => invoke('project:read', file),
    write: (file, text) => invoke('project:write', file, text),
    recent: () => invoke('recent:get'),
    addRecent: (file, name) => invoke('recent:add', file, name),
    autosave: (text, meta) => invoke('autosave:write', text, meta),
    loadAutosave: () => invoke('autosave:read'),
    clearAutosave: () => invoke('autosave:clear'),
  },
  fs: {
    exists: (files) => invoke('fs:exists', files),
    writeTemp: (name, data) => invoke('fs:writeTemp', name, data),
    writeMedia: (name, data) => invoke('fs:writeMedia', name, data),
    writeBinary: (file, data) => invoke('fs:writeBinary', file, data),
  },
  device: {
    profile: () => invoke('device:profile'),
  },
  media: {
    probe: (file) => invoke('media:probe', file),
    thumbs: (file, duration, opts) => invoke('media:thumbs', file, duration, opts),
    peaks: (file) => invoke('media:peaks', file),
    proxy: (opts) => invoke('media:proxy', opts),
    frame: (file, time) => invoke('media:frame', file, time),
    onProxyProgress: (cb) => on('media:proxy-progress', cb),
  },
  exporter: {
    caps: () => invoke('export:caps'),
    start: (payload) => invoke('export:start', payload),
    cancel: () => invoke('export:cancel'),
    onProgress: (cb) => on('export:progress', cb),
  },
  shell: {
    showItem: (file) => invoke('shell:showItem', file),
    openPath: (file) => invoke('shell:openPath', file),
    openRecordings: () => invoke('shell:openRecordings'),
  },
  rec: {
    permissions: () => invoke('rec:permissions'),
    askMedia: (kind) => invoke('rec:askMedia', kind),
    openPrivacy: (kind) => invoke('rec:openPrivacy', kind),
    sources: () => invoke('rec:sources'),
    displays: () => invoke('rec:displays'),
    selectRegion: (displayId) => invoke('rec:selectRegion', displayId),
    start: (cfg) => invoke('rec:start', cfg),
    onProcessing: (cb) => on('rec:processing', cb),
    onFinished: (cb) => on('rec:finished', cb),
  },
  recbar: {
    config: () => invoke('recbar:config'),
    chunk: (key, data) => ipcRenderer.send('recbar:chunk', key, data),
    finish: (payload) => invoke('recbar:finish', payload),
    resize: (w, h) => ipcRenderer.send('recbar:resize', w, h),
    onCommand: (cb) => on('recbar:command', cb),
  },
  region: {
    done: (rect) => ipcRenderer.send('region:done', rect),
  },
  voice: {
    begin: () => invoke('voice:begin'),
    chunk: (id, data) => ipcRenderer.send('voice:chunk', id, data),
    end: (id, cancelled) => invoke('voice:end', id, cancelled),
  },
  // Conexión con asistentes de IA (servidor MCP local).
  ai: {
    status: () => invoke('ai:status'),
    setEnabled: (v) => invoke('ai:setEnabled', !!v),
    install: (target) => invoke('ai:install', target),
    copy: (text) => invoke('ai:copy', text),
    showConfig: (target) => invoke('ai:showConfig', target),
    onStatus: (cb) => on('ai:status', cb),
    ready: () => ipcRenderer.send('ai:ready'),
    onCall: (cb) => on('ai:call', cb),
    onCancel: (cb) => on('ai:cancel', cb),
    reply: (id, res) => ipcRenderer.send('ai:result', id, res),
    progress: (id, p) => ipcRenderer.send('ai:progress', id, p),
    silences: (opts) => invoke('ai:silences', opts),
    scenes: (opts) => invoke('ai:scenes', opts),
    samples: (opts) => invoke('ai:samples', opts),
    saveProject: (file, text, opts) => invoke('ai:saveProject', file, text, opts),
  },
  test: {
    recCommand: (cmd) => invoke('test:recCommand', cmd),
    allowWrite: (file) => invoke('test:allowWrite', file),
    capture: (name) => invoke('test:capture', name),
    log: (msg) => invoke('test:log', msg),
    metrics: () => invoke('test:metrics'),
    done: (code) => invoke('test:done', code),
  },
});
