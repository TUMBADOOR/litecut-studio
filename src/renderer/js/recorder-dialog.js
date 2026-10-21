// Diálogo para configurar e iniciar la grabación de pantalla.
import { h, modal, segmented, selectRow, toggleRow, btn, toast, alertDialog } from './ui.js';
import { icon } from './icons.js';

const api = window.api;
const isMac = api.platform === 'darwin';
const PREF_KEY = 'litecut.recorder';

function loadPrefs() {
  try {
    return { mode: 'screen', mic: 'default', systemAudio: !isMac, webcam: '', fps: 30, maxHeight: 1080, countdown: true, hideEditor: true, after: 'editor', ...JSON.parse(localStorage.getItem(PREF_KEY) || '{}') };
  } catch {
    return { mode: 'screen', mic: 'default', systemAudio: !isMac, webcam: '', fps: 30, maxHeight: 1080, countdown: true, hideEditor: true, after: 'editor' };
  }
}

async function listDevices() {
  // Pide permiso una vez para que aparezcan los nombres de los dispositivos.
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    s.getTracks().forEach((t) => t.stop());
  } catch {
    /* sin micrófono o sin permiso */
  }
  const devs = await navigator.mediaDevices.enumerateDevices().catch(() => []);
  return {
    mics: devs.filter((d) => d.kind === 'audioinput'),
    cams: devs.filter((d) => d.kind === 'videoinput'),
  };
}

export async function openRecorderDialog() {
  if (isMac) {
    const perm = await api.rec.permissions();
    if (perm.screen !== 'granted') {
      await alertDialog(
        'Permiso para grabar la pantalla',
        'macOS necesita que autorices a LiteCut Studio en Ajustes del Sistema › Privacidad y seguridad › Grabación de pantalla. Después de activarlo, cierra y vuelve a abrir la aplicación.'
      );
      api.rec.openPrivacy('screen');
    }
  }
  const prefs = loadPrefs();
  const save = () => localStorage.setItem(PREF_KEY, JSON.stringify(prefs));
  const body = h('div', { class: 'rec-body' }, h('div', { class: 'loading' }, 'Buscando pantallas y ventanas…'));
  let meterStream = null;
  let meterCtx = null;
  let camStream = null;
  const stopPreviews = () => {
    meterStream?.getTracks().forEach((t) => t.stop());
    meterStream = null;
    meterCtx?.close().catch(() => {});
    meterCtx = null;
    camStream?.getTracks().forEach((t) => t.stop());
    camStream = null;
  };
  const m = modal({ title: 'Grabar pantalla', body, width: 760, className: 'rec-modal', onClose: stopPreviews });

  // Los dispositivos se cargan aparte (con límite de tiempo) para mostrar las pantallas cuanto antes.
  let devices = { mics: [], cams: [], loading: true };
  const devicesReady = Promise.race([listDevices(), new Promise((r) => setTimeout(() => r({ mics: [], cams: [], timeout: true }), 5000))]);
  const srcRes = await api.rec.sources();
  if (!srcRes.ok) {
    body.innerHTML = '';
    body.append(h('p', { class: 'dialog-text' }, `No se pudieron obtener las fuentes de captura: ${srcRes.error.message}`));
    return;
  }
  const sources = srcRes.sources;
  const screens = sources.filter((s) => s.type === 'screen');
  const windows = sources.filter((s) => s.type === 'window');
  let selected = null;

  const meterBar = h('i');
  const meter = h('div', { class: 'meter', title: 'Nivel del micrófono' }, meterBar);
  const camVideo = h('video', { class: 'cam-preview', muted: true, autoplay: true, playsinline: true });

  async function startMeter() {
    meterStream?.getTracks().forEach((t) => t.stop());
    meterCtx?.close().catch(() => {});
    meterStream = null;
    meterCtx = null;
    meterBar.style.width = '0%';
    if (!prefs.mic) return;
    try {
      meterStream = await navigator.mediaDevices.getUserMedia({ audio: prefs.mic === 'default' ? true : { deviceId: { exact: prefs.mic } } });
      meterCtx = new AudioContext();
      const an = meterCtx.createAnalyser();
      an.fftSize = 512;
      meterCtx.createMediaStreamSource(meterStream).connect(an);
      const data = new Uint8Array(an.fftSize);
      const tick = () => {
        if (!meterCtx) return;
        an.getByteTimeDomainData(data);
        let peak = 0;
        for (const v of data) peak = Math.max(peak, Math.abs(v - 128));
        meterBar.style.width = `${Math.min(100, (peak / 128) * 160)}%`;
        requestAnimationFrame(tick);
      };
      tick();
    } catch {
      toast('No se pudo acceder al micrófono', { type: 'error' });
    }
  }

  async function startCam() {
    camStream?.getTracks().forEach((t) => t.stop());
    camStream = null;
    camVideo.srcObject = null;
    camVideo.style.display = 'none';
    if (!prefs.webcam) return;
    try {
      camStream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: prefs.webcam }, width: { ideal: 640 }, height: { ideal: 360 } } });
      camVideo.srcObject = camStream;
      camVideo.style.display = 'block';
    } catch {
      toast('No se pudo abrir la cámara', { type: 'error' });
    }
  }

  const render = () => {
    body.innerHTML = '';
    const list = prefs.mode === 'window' ? windows : screens;
    if (!selected || !list.some((s) => s.id === selected.id)) selected = list[0] || null;
    const grid = h('div', { class: 'src-grid' });
    for (const s of list) {
      const card = h('button', { class: `src-card${selected && selected.id === s.id ? ' on' : ''}`, type: 'button', title: s.name }, s.thumbnail ? h('img', { src: s.thumbnail, alt: '' }) : h('span', { class: 'no-thumb', html: icon(s.type === 'screen' ? 'monitor' : 'window', 28) }), h('span', { class: 'src-name' }, s.name));
      card.addEventListener('click', () => {
        selected = s;
        for (const c of grid.children) c.classList.toggle('on', c === card);
      });
      grid.append(card);
    }
    if (!list.length) grid.append(h('p', { class: 'hint' }, prefs.mode === 'window' ? 'No se encontraron ventanas abiertas.' : 'No se encontraron pantallas.'));
    const micOpts = [{ value: '', label: 'Sin micrófono' }, { value: 'default', label: 'Micrófono predeterminado' }, ...devices.mics.filter((d) => d.deviceId && d.deviceId !== 'default').map((d, i) => ({ value: d.deviceId, label: d.label || `Micrófono ${i + 1}` }))];
    const camOpts = [{ value: '', label: devices.loading ? 'Buscando cámaras…' : devices.cams.length ? 'Sin cámara' : 'No se encontró ninguna cámara' }, ...devices.cams.map((d, i) => ({ value: d.deviceId, label: d.label || `Cámara ${i + 1}` }))];
    if (!devices.loading && prefs.webcam && !devices.cams.some((d) => d.deviceId === prefs.webcam)) prefs.webcam = '';
    const micRow = selectRow({
      label: 'Micrófono',
      value: prefs.mic,
      options: micOpts,
      onChange: (v) => {
        prefs.mic = v;
        save();
        startMeter();
      },
    });
    micRow.querySelector('.ctl-in').append(meter);
    const camRow = selectRow({
      label: 'Cámara web',
      value: prefs.webcam,
      options: camOpts,
      onChange: (v) => {
        prefs.webcam = v;
        save();
        startCam();
      },
    });
    const parts = [
      h(
        'div',
        { class: 'rec-modes' },
        segmented({
          options: [
            { value: 'screen', label: 'Pantalla completa', icon: 'monitor' },
            { value: 'window', label: 'Ventana', icon: 'window' },
            { value: 'region', label: 'Área personalizada', icon: 'region' },
          ],
          value: prefs.mode,
          onChange: (v) => {
            prefs.mode = v;
            save();
            render();
          },
        })
      ),
      prefs.mode === 'region' ? h('p', { class: 'hint' }, 'Elige la pantalla; al pulsar «Grabar» podrás dibujar el área con el ratón.') : null,
      grid,
      h(
        'div',
        { class: 'rec-cols' },
        h(
          'div',
          {},
          h('h4', {}, 'Audio'),
          micRow,
          toggleRow({
            label: isMac ? 'Audio del sistema (macOS 13+, puede no estar disponible)' : 'Audio del sistema (lo que suena en el equipo)',
            value: prefs.systemAudio,
            onChange: (v) => {
              prefs.systemAudio = v;
              save();
            },
          }),
          h('h4', {}, 'Cámara'),
          camRow,
          camVideo
        ),
        h(
          'div',
          {},
          h('h4', {}, 'Calidad'),
          selectRow({
            label: 'Fotogramas/s',
            value: prefs.fps,
            options: [
              { value: 15, label: '15 fps (tutoriales, muy liviano)' },
              { value: 30, label: '30 fps (recomendado)' },
              { value: 60, label: '60 fps (juegos, más pesado)' },
            ],
            onChange: (v) => {
              prefs.fps = +v;
              save();
            },
          }),
          selectRow({
            label: 'Resolución máxima',
            value: prefs.maxHeight,
            options: [
              { value: 0, label: 'Original de la pantalla' },
              { value: 1080, label: 'Hasta 1080p' },
              { value: 720, label: 'Hasta 720p (más liviano)' },
            ],
            onChange: (v) => {
              prefs.maxHeight = +v;
              save();
            },
          }),
          h('h4', {}, 'Opciones'),
          toggleRow({ label: 'Cuenta regresiva de 3 segundos', value: prefs.countdown, onChange: (v) => ((prefs.countdown = v), save()) }),
          toggleRow({ label: 'Minimizar el editor al grabar', value: prefs.hideEditor, onChange: (v) => ((prefs.hideEditor = v), save()) }),
          h(
            'div',
            { class: 'ctl' },
            h('label', {}, 'Al terminar'),
            segmented({
              options: [
                { value: 'editor', label: 'Añadir al proyecto' },
                { value: 'save', label: 'Solo guardar' },
              ],
              value: prefs.after,
              small: true,
              onChange: (v) => {
                prefs.after = v;
                save();
              },
            })
          )
        )
      ),
      h(
        'div',
        { class: 'modal-foot inline' },
        h('span', { class: 'hint grow' }, `Detener: ${isMac ? '⌘' : 'Ctrl'}+Alt+S · Pausa: ${isMac ? '⌘' : 'Ctrl'}+Alt+P`),
        btn('Cancelar', { onClick: () => m.close() }),
        btn('Grabar', { kind: 'rec-btn', icon: 'record', onClick: () => go() })
      ),
    ];
    body.append(...parts.filter(Boolean));
  };

  const go = async () => {
    if (!selected) {
      toast('Elige qué quieres grabar', { type: 'error' });
      return;
    }
    let region = null;
    if (prefs.mode === 'region') {
      region = await api.rec.selectRegion(selected.displayId);
      if (!region) return;
    }
    stopPreviews();
    const cfg = {
      sourceId: selected.id,
      sourceType: selected.type,
      displayId: selected.displayId,
      region,
      mic: prefs.mic || null,
      systemAudio: !!prefs.systemAudio,
      webcam: prefs.webcam || null,
      fps: prefs.fps,
      maxHeight: prefs.maxHeight || null,
      countdown: prefs.countdown,
      hideEditor: prefs.hideEditor,
      mode: prefs.after,
    };
    const r = await api.rec.start(cfg);
    if (r && r.ok === false) {
      toast(`No se pudo iniciar la grabación: ${r.error?.message || ''}`, { type: 'error', timeout: 6000 });
      return;
    }
    m.close();
  };

  render();
  devicesReady.then((d) => {
    if (!document.body.contains(m.el)) return;
    devices = d;
    if (!d.mics.length && prefs.mic) prefs.mic = d.timeout ? prefs.mic : '';
    render();
    startMeter();
    startCam();
  });
}
