// Detección de ritmo para poner marcadores en los pulsos de una canción.
// 1) Envolvente de «golpes»: flujo espectral (cuánto aumenta la energía en cada banda) en ventanas cortas.
// 2) Tempo: autocorrelación de la envolvente entre 60 y 200 BPM, prefiriendo tempos habituales (~120).
// 3) Pulsos: se encadenan golpes separados más o menos un periodo (programación dinámica).
// Trabaja con PCM mono en Float32Array; no depende del navegador ni de Node.

const FFT_SIZE = 512;
const HOP = 128;

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}

// Envolvente de golpes (una muestra cada HOP muestras de audio).
export function onsetEnvelope(samples, rate) {
  const frames = Math.max(0, Math.floor((samples.length - FFT_SIZE) / HOP) + 1);
  const env = new Float32Array(frames);
  const win = new Float32Array(FFT_SIZE).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FFT_SIZE));
  const bins = FFT_SIZE / 2;
  // Solo hasta ~6 kHz: ahí están bombo, caja y platillos sin el ruido de las frecuencias más altas.
  const top = Math.min(bins, Math.round((6000 / rate) * FFT_SIZE));
  let prev = new Float32Array(bins);
  let cur = new Float32Array(bins);
  const re = new Float32Array(FFT_SIZE);
  const im = new Float32Array(FFT_SIZE);
  for (let f = 0; f < frames; f++) {
    const off = f * HOP;
    for (let i = 0; i < FFT_SIZE; i++) {
      re[i] = samples[off + i] * win[i];
      im[i] = 0;
    }
    fft(re, im);
    let flux = 0;
    for (let k = 1; k < top; k++) {
      cur[k] = Math.log1p(100 * Math.hypot(re[k], im[k]));
      const d = cur[k] - prev[k];
      if (d > 0) flux += d;
    }
    env[f] = f ? flux : 0;
    [prev, cur] = [cur, prev];
  }
  // Se resta la media local para quedarse con los picos.
  const out = new Float32Array(frames);
  const w = Math.max(1, Math.round((0.25 * rate) / HOP));
  let sum = 0;
  for (let i = 0; i < Math.min(frames, w); i++) sum += env[i];
  for (let i = 0; i < frames; i++) {
    if (i + w < frames) sum += env[i + w];
    if (i - w - 1 >= 0) sum -= env[i - w - 1];
    const n = Math.min(frames - 1, i + w) - Math.max(0, i - w) + 1;
    out[i] = Math.max(0, env[i] - sum / n);
  }
  return { env: out, rate: rate / HOP };
}

// Regularidad del pulso: autocorrelación en el periodo frente a la varianza (1 = golpes perfectamente
// regulares; ruido o un tono continuo dan casi 0).
export function pulseStrength(env, period) {
  const n = env.length;
  const lag = Math.round(period);
  if (!(lag > 0) || lag >= n) return 0;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += env[i];
  mean /= n;
  let v = 0;
  let c = 0;
  for (let i = 0; i < n; i++) v += (env[i] - mean) ** 2;
  for (let i = 0; i + lag < n; i++) c += (env[i] - mean) * (env[i + lag] - mean);
  return v > 0 ? c / ((v * (n - lag)) / n) : 0;
}

// Periodo (en muestras de la envolvente, con decimales) del pulso más probable.
export function estimatePeriod(env, envRate, { minBpm = 60, maxBpm = 200 } = {}) {
  const n = env.length;
  const minLag = Math.max(1, Math.floor((60 / maxBpm) * envRate));
  const maxLag = Math.min(n - 2, Math.ceil((60 / minBpm) * envRate));
  if (maxLag <= minLag) return 0;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += env[i];
  mean /= n || 1;
  const ac = new Float32Array(maxLag + 2);
  for (let lag = minLag - 1; lag <= maxLag + 1; lag++) {
    let s = 0;
    for (let i = 0; i + lag < n; i++) s += (env[i] - mean) * (env[i + lag] - mean);
    ac[lag] = s / (n - lag);
  }
  let best = 0;
  let bestScore = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const bpm = (60 * envRate) / lag;
    const weight = Math.exp(-0.5 * (Math.log2(bpm / 120) / 0.9) ** 2);
    // Los pulsos reales también se repiten al doble de distancia: suma ese eco para no confundir el compás.
    const twice = 2 * lag <= maxLag + 1 ? Math.max(0, ac[2 * lag]) * 0.5 : 0;
    const score = (ac[lag] + twice) * weight;
    if (ac[lag] > ac[lag - 1] && ac[lag] >= ac[lag + 1] && score > bestScore) {
      bestScore = score;
      best = lag;
    }
  }
  if (!best || bestScore <= 0) return 0;
  // Interpolación parabólica para afinar el periodo entre muestras.
  const a = ac[best - 1];
  const b = ac[best];
  const c = ac[best + 1];
  const den = a - 2 * b + c;
  return den < 0 ? best + (0.5 * (a - c)) / den : best;
}

// Índices (en muestras de la envolvente) de los pulsos, por programación dinámica: cada pulso busca el anterior
// a un periodo de distancia que mejor encadena golpes fuertes; así la rejilla sigue a la música aunque el tempo
// estimado no sea exacto o varíe un poco.
export function trackBeats(env, period, { tightness = 100 } = {}) {
  const n = env.length;
  if (!(period > 0) || n < 2) return [];
  let mean = 0;
  for (let i = 0; i < n; i++) mean += env[i];
  mean /= n;
  let sd = 0;
  for (let i = 0; i < n; i++) sd += (env[i] - mean) ** 2;
  sd = Math.sqrt(sd / n) || 1;
  // Puntuación local: la envolvente normalizada y suavizada (gaussiana de ~1/16 de pulso).
  const sigma = Math.max(0.5, period / 16);
  const r = Math.ceil(sigma * 3);
  const kernel = Array.from({ length: 2 * r + 1 }, (_, k) => Math.exp(-0.5 * ((k - r) / sigma) ** 2));
  const local = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = -r; k <= r; k++) if (i + k >= 0 && i + k < n) s += (env[i + k] / sd) * kernel[k + r];
    local[i] = s;
  }
  const score = new Float32Array(n);
  const back = new Int32Array(n).fill(-1);
  const lo = Math.max(1, Math.round(period / 2));
  const hi = Math.round(period * 2);
  for (let i = 0; i < n; i++) {
    let best = -Infinity;
    let bj = -1;
    for (let j = Math.max(0, i - hi); j <= i - lo; j++) {
      const v = score[j] - tightness * Math.log((i - j) / period) ** 2;
      if (v > best) {
        best = v;
        bj = j;
      }
    }
    score[i] = local[i] + (bj >= 0 && best > 0 ? best : 0);
    back[i] = bj >= 0 && best > 0 ? bj : -1;
  }
  // Último pulso: el de mejor puntuación acumulada en el último periodo; desde ahí hacia atrás.
  let last = n - 1;
  for (let i = Math.max(0, n - Math.ceil(period)); i < n; i++) if (score[i] > score[last]) last = i;
  const idx = [];
  for (let i = last; i >= 0; i = back[i]) idx.push(i);
  idx.reverse();
  // Fuera los pulsos sueltos del principio y del final que no caen sobre ningún golpe (silencio, intro).
  const strength = idx.map((i) => local[i]);
  const sorted = [...strength].sort((a, b) => a - b);
  const floor = 0.3 * (sorted[Math.floor(sorted.length / 2)] || 0);
  let a = 0;
  let b = idx.length - 1;
  while (a <= b && strength[a] < floor) a++;
  while (b >= a && strength[b] < floor) b--;
  return idx.slice(a, b + 1);
}

// Todo junto: PCM mono → { bpm, beats } (beats en segundos desde el inicio del PCM).
// Sin un ritmo claro (voz, un tono continuo, ruido) devuelve { bpm: 0, beats: [] } en vez de inventar pulsos:
// hacen falta golpes marcados (percentil 95 de la envolvente) y que se repitan con regularidad.
export function analyzeBeats(samples, rate) {
  const { env, rate: envRate } = onsetEnvelope(samples, rate);
  if (env.length < envRate * 2) return { bpm: 0, beats: [] };
  const sorted = Float32Array.from(env).sort();
  if (sorted[Math.floor(sorted.length * 0.95)] < 2) return { bpm: 0, beats: [] };
  const period = estimatePeriod(env, envRate);
  if (!period || pulseStrength(env, period) < 0.12) return { bpm: 0, beats: [] };
  // Un golpe se nota en la ventana de análisis antes de llegar a su centro: se compensa ese adelanto.
  const lag = (0.75 * FFT_SIZE) / rate;
  return { bpm: Math.round(((60 * envRate) / period) * 10) / 10, beats: trackBeats(env, period).map((i) => i / envRate + lag) };
}
