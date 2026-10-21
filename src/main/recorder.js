// Coordinación del grabador de pantalla en el proceso principal:
// fuentes de captura, selección de región, barra flotante de control y posprocesado con FFmpeg.
import { BrowserWindow, desktopCapturer, screen, session, globalShortcut, systemPreferences, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { finalizeRecording, lastLines } from './ffmpeg.js';

const pad = (n) => String(n).padStart(2, '0');
export function stamp(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}.${pad(d.getSeconds())}`;
}

export class RecorderController {
  constructor({ getMainWindow, preload, appUrl, recordingsDir, tempDir, getHw, isMac }) {
    this.getMainWindow = getMainWindow;
    this.preload = preload;
    this.appUrl = appUrl;
    this.recordingsDir = recordingsDir;
    this.tempDir = tempDir;
    this.getHw = getHw;
    this.isMac = isMac;
    this.active = null;
    this.voice = new Map();
  }

  send(channel, payload) {
    const w = this.getMainWindow();
    if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
  }

  // ---------- Permisos (macOS) ----------
  permissions() {
    if (!this.isMac) return { screen: 'granted', camera: 'granted', microphone: 'granted' };
    return {
      screen: systemPreferences.getMediaAccessStatus('screen'),
      camera: systemPreferences.getMediaAccessStatus('camera'),
      microphone: systemPreferences.getMediaAccessStatus('microphone'),
    };
  }

  async askMedia(kind) {
    if (!this.isMac) return true;
    try {
      return await systemPreferences.askForMediaAccess(kind);
    } catch {
      return false;
    }
  }

  openPrivacy(kind) {
    if (!this.isMac) return;
    const pane = { screen: 'Privacy_ScreenCapture', camera: 'Privacy_Camera', microphone: 'Privacy_Microphone' }[kind] || 'Privacy';
    shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${pane}`);
  }

  // ---------- Fuentes ----------
  async sources() {
    const own = new Set(BrowserWindow.getAllWindows().map((w) => w.getMediaSourceId()));
    const list = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 }, fetchWindowIcons: false });
    const displays = screen.getAllDisplays();
    let screenIndex = 0;
    return list
      .filter((s) => !own.has(s.id))
      .map((s) => {
        const isScreen = s.id.startsWith('screen');
        const d = isScreen ? displays.find((x) => String(x.id) === String(s.display_id)) : null;
        return {
          id: s.id,
          type: isScreen ? 'screen' : 'window',
          name: isScreen ? `Pantalla ${++screenIndex}${d ? ` (${d.size.width}×${d.size.height})` : ''}` : s.name,
          displayId: s.display_id ? String(s.display_id) : null,
          thumbnail: s.thumbnail && !s.thumbnail.isEmpty() ? s.thumbnail.toDataURL() : null,
        };
      });
  }

  displays() {
    const primary = screen.getPrimaryDisplay().id;
    return screen.getAllDisplays().map((d) => ({ id: String(d.id), bounds: d.bounds, size: d.size, scaleFactor: d.scaleFactor, primary: d.id === primary }));
  }

  findDisplay(displayId) {
    const all = screen.getAllDisplays();
    return all.find((d) => String(d.id) === String(displayId)) || screen.getPrimaryDisplay();
  }

  // ---------- Selección de región ----------
  selectRegion(displayId) {
    const d = this.findDisplay(displayId);
    return new Promise((resolve) => {
      const win = new BrowserWindow({
        x: d.bounds.x,
        y: d.bounds.y,
        width: d.bounds.width,
        height: d.bounds.height,
        frame: false,
        transparent: true,
        alwaysOnTop: true,
        skipTaskbar: true,
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        hasShadow: false,
        enableLargerThanScreen: true,
        show: false,
        webPreferences: { preload: this.preload, contextIsolation: true, sandbox: true },
      });
      win.setAlwaysOnTop(true, 'screen-saver');
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      let done = false;
      const finish = (rect) => {
        if (done) return;
        done = true;
        if (!win.isDestroyed()) win.close();
        if (!rect || rect.w < 16 || rect.h < 16) return resolve(null);
        const W = d.bounds.width;
        const H = d.bounds.height;
        resolve({ x: rect.x / W, y: rect.y / H, w: rect.w / W, h: rect.h / H, pxW: Math.round(rect.w * d.scaleFactor), pxH: Math.round(rect.h * d.scaleFactor) });
      };
      win.webContents.ipc.on('region:done', (_e, rect) => finish(rect));
      win.on('closed', () => finish(null));
      win.loadURL(this.appUrl('region.html?mode=select'));
      win.once('ready-to-show', () => {
        win.show();
        win.focus();
      });
    });
  }

  showRegionFrame(d, region) {
    const r = {
      x: Math.round(d.bounds.x + region.x * d.bounds.width) - 3,
      y: Math.round(d.bounds.y + region.y * d.bounds.height) - 3,
      width: Math.round(region.w * d.bounds.width) + 6,
      height: Math.round(region.h * d.bounds.height) + 6,
    };
    const win = new BrowserWindow({
      ...r,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      focusable: false,
      resizable: false,
      movable: false,
      hasShadow: false,
      show: false,
      enableLargerThanScreen: true,
      webPreferences: { preload: this.preload, contextIsolation: true, sandbox: true },
    });
    win.setIgnoreMouseEvents(true);
    win.setContentProtection(true);
    win.setAlwaysOnTop(true, 'screen-saver');
    win.loadURL(this.appUrl('region.html?mode=frame'));
    win.once('ready-to-show', () => win.showInactive());
    return win;
  }

  // ---------- Grabación ----------
  async start(cfg) {
    if (this.active) throw new Error('Ya hay una grabación en curso.');
    const all = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } });
    const source = all.find((s) => s.id === cfg.sourceId);
    if (!source) throw new Error('La pantalla o ventana elegida ya no está disponible.');
    fs.mkdirSync(this.tempDir, { recursive: true });
    const id = Date.now().toString(36);
    const files = {
      screen: path.join(this.tempDir, `rec_${id}_screen.webm`),
      webcam: cfg.webcam ? path.join(this.tempDir, `rec_${id}_webcam.webm`) : null,
    };
    const rec = {
      id,
      cfg,
      source,
      files,
      streams: {
        screen: fs.createWriteStream(files.screen),
        webcam: files.webcam ? fs.createWriteStream(files.webcam) : null,
      },
      startedAt: Date.now(),
    };
    this.active = rec;

    session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
      const cur = this.active;
      if (!cur) {
        callback({});
        return;
      }
      if (cur.cfg.systemAudio && request.audioRequested) {
        try {
          callback({ video: cur.source, audio: 'loopback' });
          return;
        } catch {
          /* sin audio del sistema en esta plataforma */
        }
      }
      callback({ video: cur.source });
    });

    const display = cfg.displayId ? this.findDisplay(cfg.displayId) : screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const wa = display.workArea;
    const barW = 420;
    const barH = 64;
    const bar = new BrowserWindow({
      width: barW,
      height: barH,
      x: Math.round(wa.x + (wa.width - barW) / 2),
      y: wa.y + 14,
      frame: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      alwaysOnTop: true,
      skipTaskbar: false,
      backgroundColor: '#17171c',
      title: 'Grabando — LiteCut Studio',
      show: false,
      webPreferences: {
        preload: this.preload,
        contextIsolation: true,
        sandbox: true,
        backgroundThrottling: false,
        autoplayPolicy: 'no-user-gesture-required',
      },
    });
    bar.setAlwaysOnTop(true, 'screen-saver');
    bar.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    bar.setContentProtection(true); // la barra no aparece en la grabación
    bar.on('close', (e) => {
      if (this.active && !this.active.finishing) {
        e.preventDefault();
        bar.webContents.send('recbar:command', 'stop');
      }
    });
    rec.bar = bar;
    bar.loadURL(this.appUrl('recorder.html'));
    bar.once('ready-to-show', () => bar.show());

    if (cfg.region && source.id.startsWith('screen')) rec.frame = this.showRegionFrame(display, cfg.region);

    const main = this.getMainWindow();
    if (cfg.hideEditor && main && !main.isDestroyed()) main.minimize();

    const reg = (acc, cmd) => {
      try {
        globalShortcut.register(acc, () => rec.bar && !rec.bar.isDestroyed() && rec.bar.webContents.send('recbar:command', cmd));
      } catch {
        /* atajo ocupado por otra app */
      }
    };
    reg('CommandOrControl+Alt+S', 'stop');
    reg('CommandOrControl+Alt+P', 'pause');
    return { ok: true };
  }

  barConfig() {
    const rec = this.active;
    if (!rec) return null;
    return { ...rec.cfg, platform: process.platform };
  }

  chunk(key, data) {
    const rec = this.active;
    const s = rec?.streams?.[key];
    if (s && data) s.write(Buffer.from(data));
  }

  async finish(payload = {}) {
    const rec = this.active;
    if (!rec || rec.finishing) return;
    rec.finishing = true;
    globalShortcut.unregister('CommandOrControl+Alt+S');
    globalShortcut.unregister('CommandOrControl+Alt+P');
    await Promise.all(
      Object.values(rec.streams)
        .filter(Boolean)
        .map((s) => new Promise((r) => s.end(r)))
    );
    if (rec.frame && !rec.frame.isDestroyed()) rec.frame.close();
    if (rec.bar && !rec.bar.isDestroyed()) rec.bar.close();
    const main = this.getMainWindow();
    if (main && !main.isDestroyed()) {
      if (main.isMinimized()) main.restore();
      main.show();
      main.focus();
    }
    const cleanup = () => {
      for (const f of Object.values(rec.files)) if (f) fs.rmSync(f, { force: true });
    };
    if (payload.cancelled || payload.error) {
      cleanup();
      this.active = null;
      this.send('rec:finished', { cancelled: !!payload.cancelled, error: payload.error || null });
      return;
    }
    this.send('rec:processing', { progress: 0 });
    try {
      fs.mkdirSync(this.recordingsDir, { recursive: true });
      const base = path.join(this.recordingsDir, `Grabación ${stamp()}`);
      const hw = await this.getHw();
      const crop = rec.cfg.mode === 'save' && rec.cfg.region ? rec.cfg.region : null;
      const duration = (payload.durationMs || 0) / 1000;
      const screenOut = await finalizeRecording(rec.files.screen, base, {
        videoCodec: payload.screenMime || '',
        hasAudio: !!payload.screenHasAudio,
        crop,
        hw: hw?.h264 || null,
        duration,
        onProgress: (p) => this.send('rec:processing', { progress: p }),
      });
      let webcamOut = null;
      if (rec.files.webcam && fs.existsSync(rec.files.webcam) && fs.statSync(rec.files.webcam).size > 1000) {
        try {
          webcamOut = await finalizeRecording(rec.files.webcam, `${base} (cámara)`, { videoCodec: payload.webcamMime || '', hasAudio: false });
        } catch {
          webcamOut = null;
        }
      }
      cleanup();
      this.active = null;
      this.send('rec:finished', { screen: screenOut, webcam: webcamOut, region: rec.cfg.region || null, mode: rec.cfg.mode, warning: payload.warning || null });
    } catch (err) {
      this.active = null;
      this.send('rec:finished', { error: `${err.message}${err.details ? `\n${err.details}` : ''}`, raw: rec.files.screen });
    }
  }

  // ---------- Voz en off (graba la ventana principal) ----------
  voiceBegin() {
    fs.mkdirSync(this.tempDir, { recursive: true });
    const id = `v${Date.now().toString(36)}`;
    const file = path.join(this.tempDir, `${id}.webm`);
    this.voice.set(id, { file, stream: fs.createWriteStream(file) });
    return id;
  }

  voiceChunk(id, data) {
    const v = this.voice.get(id);
    if (v && data) v.stream.write(Buffer.from(data));
  }

  async voiceEnd(id, cancelled) {
    const v = this.voice.get(id);
    if (!v) return null;
    this.voice.delete(id);
    await new Promise((r) => v.stream.end(r));
    if (cancelled) {
      fs.rmSync(v.file, { force: true });
      return null;
    }
    fs.mkdirSync(this.recordingsDir, { recursive: true });
    try {
      const out = await finalizeRecording(v.file, path.join(this.recordingsDir, `Voz en off ${stamp()}`), { audioOnly: true });
      fs.rmSync(v.file, { force: true });
      return out;
    } catch (err) {
      throw new Error(`No se pudo guardar la voz: ${err.message}\n${lastLines(err.details || '')}`);
    }
  }
}
