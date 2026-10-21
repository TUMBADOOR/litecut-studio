// Barra flotante de grabación: captura la pantalla (y opcionalmente micrófono, audio del sistema
// y cámara) con MediaRecorder y envía los datos al proceso principal en trozos de 1 segundo.
import { icon } from './icons.js';

const api = window.api;
const $ = (id) => document.getElementById(id);
const mod = api.platform === 'darwin' ? '⌘' : 'Ctrl';

let cfg = null;
let screenStream = null;
let micStream = null;
let camStream = null;
let mixCtx = null;
let meterCtx = null;
let audioTrack = null;
let screenRec = null;
let camRec = null;
let screenChain = Promise.resolve();
let camChain = Promise.resolve();
let state = 'starting';
let elapsed = 0;
let lastStart = 0;
let finishing = false;
const warnings = [];

$('pause').innerHTML = icon('pause', 18);
$('stop').innerHTML = icon('stop', 18);
$('discard').innerHTML = icon('trash', 17);
$('pause').title = `Pausar (${mod}+Alt+P)`;
$('stop').title = `Detener y guardar (${mod}+Alt+S)`;

function setMsg(text) {
  $('msg').textContent = text || '';
  document.body.classList.toggle('has-msg', !!text);
}

function pickMime(hasAudio) {
  const list = hasAudio
    ? ['video/webm;codecs=h264,opus', 'video/webm;codecs=avc1,opus', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
    : ['video/webm;codecs=h264', 'video/webm;codecs=avc1', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  return list.find((t) => MediaRecorder.isTypeSupported(t)) || '';
}

async function getScreen() {
  const video = { frameRate: { ideal: cfg.fps, max: cfg.fps } };
  if (cfg.maxHeight) video.height = { max: cfg.maxHeight };
  try {
    return await navigator.mediaDevices.getDisplayMedia({ video, audio: !!cfg.systemAudio });
  } catch (err) {
    if (!cfg.systemAudio) throw err;
    warnings.push('No se pudo capturar el audio del sistema en este equipo; se grabó sin él.');
    return navigator.mediaDevices.getDisplayMedia({ video, audio: false });
  }
}

async function getMic() {
  if (!cfg.mic) return null;
  const base = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: cfg.mic === 'default' ? base : { ...base, deviceId: { exact: cfg.mic } } });
  } catch {
    warnings.push('No se pudo abrir el micrófono; se grabó sin él.');
    return null;
  }
}

async function getCam() {
  if (!cfg.webcam) return null;
  try {
    return await navigator.mediaDevices.getUserMedia({
      video: { deviceId: { exact: cfg.webcam }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } },
      audio: false,
    });
  } catch {
    warnings.push('No se pudo abrir la cámara; se grabó sin ella.');
    return null;
  }
}

function startMeter(track) {
  if (!track) {
    $('meter').style.display = 'none';
    return;
  }
  meterCtx = new AudioContext();
  const an = meterCtx.createAnalyser();
  an.fftSize = 512;
  meterCtx.createMediaStreamSource(new MediaStream([track])).connect(an);
  const data = new Uint8Array(an.fftSize);
  const bar = $('meter').firstElementChild;
  const tick = () => {
    if (!meterCtx) return;
    an.getByteTimeDomainData(data);
    let peak = 0;
    for (const v of data) peak = Math.max(peak, Math.abs(v - 128));
    bar.style.height = `${Math.min(100, (peak / 128) * 170)}%`;
    requestAnimationFrame(tick);
  };
  tick();
}

function fmt(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`;
}

function updateTime() {
  const ms = elapsed + (state === 'recording' ? performance.now() - lastStart : 0);
  $('time').textContent = fmt(ms);
}

function makeRecorder(stream, key, opts) {
  const rec = new MediaRecorder(stream, opts);
  rec.ondataavailable = (e) => {
    if (!e.data || !e.data.size) return;
    const step = () => e.data.arrayBuffer().then((b) => api.recbar.chunk(key, b));
    if (key === 'screen') screenChain = screenChain.then(step);
    else camChain = camChain.then(step);
  };
  return rec;
}

async function countdown(n) {
  document.body.classList.add('counting');
  for (let i = n; i > 0; i--) {
    if (finishing) return false;
    $('time').textContent = `Empieza en ${i}…`;
    await new Promise((r) => setTimeout(r, 1000));
  }
  document.body.classList.remove('counting');
  return !finishing;
}

async function init() {
  cfg = await api.recbar.config();
  if (!cfg) {
    window.close();
    return;
  }
  $('time').textContent = 'Preparando…';
  try {
    screenStream = await getScreen();
  } catch (err) {
    await api.recbar.finish({ error: `No se pudo capturar la pantalla: ${err.message || err}` });
    return;
  }
  micStream = await getMic();
  camStream = await getCam();
  if (camStream) {
    $('cam').srcObject = camStream;
    document.body.classList.add('with-cam');
  }
  const sys = screenStream.getAudioTracks()[0] || null;
  const mic = micStream?.getAudioTracks()[0] || null;
  if (sys && mic) {
    mixCtx = new AudioContext();
    const dest = mixCtx.createMediaStreamDestination();
    mixCtx.createMediaStreamSource(new MediaStream([sys])).connect(dest);
    mixCtx.createMediaStreamSource(new MediaStream([mic])).connect(dest);
    audioTrack = dest.stream.getAudioTracks()[0];
  } else {
    audioTrack = sys || mic;
  }
  startMeter(mic || sys);
  const vt = screenStream.getVideoTracks()[0];
  vt.addEventListener('ended', () => stop(false));
  const s = vt.getSettings();
  const w = s.width || 1920;
  const hgt = s.height || 1080;
  const fps = Math.min(60, s.frameRate || cfg.fps || 30);
  const vbr = Math.round(Math.min(14e6, Math.max(2.5e6, w * hgt * fps * 0.09)));
  const out = new MediaStream([vt, ...(audioTrack ? [audioTrack] : [])]);
  screenRec = makeRecorder(out, 'screen', { mimeType: pickMime(!!audioTrack), videoBitsPerSecond: vbr, audioBitsPerSecond: 160000 });
  if (camStream) camRec = makeRecorder(camStream, 'webcam', { mimeType: pickMime(false), videoBitsPerSecond: 3e6 });
  if (warnings.length) setMsg(warnings[0]);
  if (cfg.countdown && !(await countdown(3))) return;
  if (finishing) return;
  screenRec.start(1000);
  camRec?.start(1000);
  lastStart = performance.now();
  state = 'recording';
  document.body.classList.add('recording');
  setInterval(updateTime, 250);
  updateTime();
}

function togglePause() {
  if (!screenRec || finishing) return;
  if (state === 'recording') {
    screenRec.pause();
    camRec?.pause();
    elapsed += performance.now() - lastStart;
    state = 'paused';
    document.body.classList.add('paused');
    $('pause').innerHTML = icon('record', 16);
    $('pause').title = `Reanudar (${mod}+Alt+P)`;
  } else if (state === 'paused') {
    screenRec.resume();
    camRec?.resume();
    lastStart = performance.now();
    state = 'recording';
    document.body.classList.remove('paused');
    $('pause').innerHTML = icon('pause', 18);
    $('pause').title = `Pausar (${mod}+Alt+P)`;
  }
  updateTime();
}

async function stop(cancel) {
  if (finishing) return;
  finishing = true;
  if (state === 'recording') elapsed += performance.now() - lastStart;
  const wasRecording = state === 'recording' || state === 'paused';
  state = 'stopping';
  document.body.classList.add('stopping');
  $('time').textContent = cancel ? 'Descartando…' : 'Guardando…';
  const stopRec = (rec) =>
    new Promise((res) => {
      if (!rec || rec.state === 'inactive') return res();
      rec.addEventListener('stop', () => res(), { once: true });
      rec.stop();
    });
  await Promise.all([stopRec(screenRec), stopRec(camRec)]);
  await screenChain;
  await camChain;
  for (const st of [screenStream, micStream, camStream]) st?.getTracks().forEach((t) => t.stop());
  mixCtx?.close().catch(() => {});
  meterCtx?.close().catch(() => {});
  meterCtx = null;
  await api.recbar.finish({
    cancelled: cancel || !wasRecording,
    screenMime: screenRec?.mimeType || '',
    webcamMime: camRec?.mimeType || '',
    screenHasAudio: !!audioTrack,
    durationMs: elapsed,
    warning: warnings.join(' ') || null,
  });
}

$('pause').addEventListener('click', togglePause);
$('stop').addEventListener('click', () => stop(false));
$('discard').addEventListener('click', () => {
  if (state === 'recording' || state === 'paused') {
    if (!confirm('¿Descartar esta grabación?')) return;
  }
  stop(true);
});
api.recbar.onCommand((cmd) => {
  if (cmd === 'stop') stop(false);
  if (cmd === 'pause') togglePause();
});

init().catch((err) => api.recbar.finish({ error: String(err?.message || err) }));
