// Grabación de voz en off: graba el micrófono mientras se reproduce el proyecto
// y coloca el audio en una pista de audio en la posición donde empezó.
import { store } from './store.js';
import { media } from './media.js';
import * as edit from './edit.js';
import { h, modal, selectRow, toggleRow, btn, toast } from './ui.js';
import { icon } from './icons.js';
import { formatTime } from '../shared/model.js';

const api = window.api;

export async function openVoiceover({ player }) {
  player.pause();
  let devices = [];
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    s.getTracks().forEach((t) => t.stop());
    devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
  } catch {
    toast('No se encontró ningún micrófono o no hay permiso para usarlo', { type: 'error', timeout: 5000 });
    return;
  }
  const st = { mic: localStorage.getItem('litecut.voiceMic') || 'default', playAlong: true, countdown: true };
  let stream = null;
  let actx = null;
  let rec = null;
  let sessionId = null;
  let chain = Promise.resolve();
  let startAt = 0;
  let t0 = 0;
  let timer = null;
  let phase = 'idle';
  const wasMuted = player.muted;

  const body = h('div', { class: 'vo-body' });
  const meterBar = h('i');
  const meter = h('div', { class: 'meter big' }, meterBar);
  const clock = h('div', { class: 'vo-clock' }, '00:00');
  const cleanup = () => {
    clearInterval(timer);
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    actx?.close().catch(() => {});
    actx = null;
    player.muted = wasMuted;
  };
  const m = modal({
    title: 'Grabar voz en off',
    body,
    width: 520,
    onClose: async () => {
      if (phase === 'recording') await finish(true);
      if (phase === 'counting') phase = 'closed';
      cleanup();
    },
  });

  async function openMic() {
    stream?.getTracks().forEach((t) => t.stop());
    actx?.close().catch(() => {});
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { ...(st.mic === 'default' ? {} : { deviceId: { exact: st.mic } }), echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    actx = new AudioContext();
    const an = actx.createAnalyser();
    an.fftSize = 512;
    actx.createMediaStreamSource(stream).connect(an);
    const data = new Uint8Array(an.fftSize);
    const tick = () => {
      if (!actx) return;
      an.getByteTimeDomainData(data);
      let peak = 0;
      for (const v of data) peak = Math.max(peak, Math.abs(v - 128));
      meterBar.style.width = `${Math.min(100, (peak / 128) * 160)}%`;
      requestAnimationFrame(tick);
    };
    tick();
  }

  const recBtn = btn('Empezar a grabar', { kind: 'rec-btn', icon: 'record', onClick: () => (phase === 'recording' ? finish(false) : begin()) });

  const render = () => {
    body.innerHTML = '';
    body.append(
      selectRow({
        label: 'Micrófono',
        value: st.mic,
        options: [{ value: 'default', label: 'Micrófono predeterminado' }, ...devices.filter((d) => d.deviceId !== 'default').map((d, i) => ({ value: d.deviceId, label: d.label || `Micrófono ${i + 1}` }))],
        onChange: (v) => {
          st.mic = v;
          localStorage.setItem('litecut.voiceMic', v);
          openMic().catch(() => toast('No se pudo abrir ese micrófono', { type: 'error' }));
        },
      }),
      meter,
      toggleRow({ label: 'Reproducir el video mientras grabo (sin sonido)', value: st.playAlong, onChange: (v) => (st.playAlong = v) }),
      toggleRow({ label: 'Cuenta regresiva de 3 segundos', value: st.countdown, onChange: (v) => (st.countdown = v) }),
      h('p', { class: 'hint' }, `La voz empezará en ${formatTime(player.time, store.project.settings.fps, true)} (posición del cursor). Usa auriculares para evitar eco.`),
      clock,
      h('div', { class: 'modal-foot inline' }, btn('Cerrar', { onClick: () => m.close() }), recBtn)
    );
  };

  async function begin() {
    if (phase !== 'idle') return;
    phase = 'counting';
    recBtn.disabled = true;
    if (st.countdown) {
      for (let i = 3; i > 0; i--) {
        clock.textContent = `Empieza en ${i}…`;
        await new Promise((r) => setTimeout(r, 1000));
        if (phase !== 'counting') return;
      }
    }
    sessionId = await api.voice.begin();
    const mime = ['audio/webm;codecs=opus', 'audio/webm'].find((t) => MediaRecorder.isTypeSupported(t)) || '';
    rec = new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: 128000 });
    rec.ondataavailable = (e) => {
      if (e.data?.size) chain = chain.then(() => e.data.arrayBuffer()).then((b) => api.voice.chunk(sessionId, b));
    };
    startAt = player.time;
    if (st.playAlong) {
      player.muted = true;
      player.play();
    }
    rec.start(1000);
    t0 = performance.now();
    phase = 'recording';
    recBtn.disabled = false;
    recBtn.querySelector('span').textContent = 'Detener';
    recBtn.querySelector('svg').outerHTML = icon('stop', 16);
    m.overlay.classList.add('busy');
    timer = setInterval(() => {
      clock.textContent = formatTime((performance.now() - t0) / 1000, 30);
    }, 200);
  }

  async function finish(cancel) {
    if (phase !== 'recording') return;
    phase = 'saving';
    clearInterval(timer);
    player.pause();
    player.muted = wasMuted;
    clock.textContent = 'Guardando…';
    await new Promise((res) => {
      rec.addEventListener('stop', res, { once: true });
      rec.stop();
    });
    await chain;
    const r = await api.voice.end(sessionId, cancel);
    m.overlay.classList.remove('busy');
    if (cancel) return;
    if (!r.ok || !r.path) {
      toast(`No se pudo guardar la voz: ${r.error?.message || ''}`, { type: 'error', timeout: 6000 });
      phase = 'idle';
      render();
      return;
    }
    const [vm] = await media.importPaths([r.path]);
    if (vm) {
      edit.addMediaClip(vm.id, { start: startAt });
      toast('Voz en off añadida a la línea de tiempo', { timeout: 2500 });
    }
    m.close();
  }

  render();
  try {
    await openMic();
  } catch {
    toast('No se pudo abrir el micrófono', { type: 'error' });
  }
}
