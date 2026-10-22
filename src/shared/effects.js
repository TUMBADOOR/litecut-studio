// Efectos de color, filtros predefinidos, máscaras, viñeta, animaciones y transiciones.
// Cada efecto se define una sola vez y se traduce a:
//   - la vista previa (canvas + filtros SVG), y
//   - la exportación (filtros de FFmpeg),
// con la misma matemática para que lo que ves sea lo que exportas.

export const ADJUST_FIELDS = [
  { key: 'brightness', label: 'Brillo', min: -100, max: 100 },
  { key: 'contrast', label: 'Contraste', min: -100, max: 100 },
  { key: 'saturation', label: 'Saturación', min: -100, max: 100 },
  { key: 'hue', label: 'Tono', min: -180, max: 180, unit: '°' },
  { key: 'temperature', label: 'Temperatura', min: -100, max: 100 },
  { key: 'tint', label: 'Matiz', min: -100, max: 100 },
  { key: 'sepia', label: 'Sepia', min: 0, max: 100 },
  { key: 'grayscale', label: 'Blanco y negro', min: 0, max: 100 },
  { key: 'blur', label: 'Desenfoque', min: 0, max: 40, unit: 'px' },
  { key: 'vignette', label: 'Viñeta', min: 0, max: 100 },
];

export const FILTER_PRESETS = [
  { id: 'none', name: 'Original', adjust: {} },
  { id: 'vivid', name: 'Vívido', adjust: { saturation: 35, contrast: 12 } },
  { id: 'warm', name: 'Cálido', adjust: { temperature: 45, saturation: 10 } },
  { id: 'cool', name: 'Frío', adjust: { temperature: -45, brightness: 3 } },
  { id: 'bw', name: 'Blanco y negro', adjust: { grayscale: 100, contrast: 15 } },
  { id: 'noir', name: 'Noir', adjust: { grayscale: 100, contrast: 45, brightness: -5, vignette: 55 } },
  { id: 'sepia', name: 'Sepia', adjust: { sepia: 85, contrast: 5 } },
  { id: 'vintage', name: 'Vintage', adjust: { sepia: 35, contrast: -12, saturation: -15, brightness: 6, vignette: 40 } },
  { id: 'faded', name: 'Desvanecido', adjust: { contrast: -28, brightness: 10, saturation: -25 } },
  { id: 'drama', name: 'Dramático', adjust: { contrast: 40, saturation: -20, brightness: -6, vignette: 45 } },
  { id: 'cinema', name: 'Cine', adjust: { contrast: 22, saturation: -12, temperature: -15, tint: 8, vignette: 30 } },
  { id: 'sunset', name: 'Atardecer', adjust: { temperature: 60, tint: 15, saturation: 20, contrast: 8 } },
  { id: 'pink', name: 'Rosa', adjust: { tint: 45, brightness: 5, saturation: 10 } },
  { id: 'neon', name: 'Neón', adjust: { saturation: 85, contrast: 25, hue: -12 } },
  { id: 'mint', name: 'Menta', adjust: { hue: 25, saturation: -10, temperature: -20, brightness: 4 } },
  { id: 'dream', name: 'Sueño', adjust: { blur: 2, brightness: 10, saturation: 15, contrast: -10 } },
];

// ---------- Matemática de color (valores sRGB 0..1) ----------

const I3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

function mul3(a, b) {
  const r = new Array(9);
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
  return r;
}

const lerpI = (m, k) => m.map((v, i) => I3[i] + (v - I3[i]) * k);

function satMatrix(s) {
  return [
    0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s,
    0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s,
    0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s,
  ];
}

function hueMatrix(deg) {
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [
    0.213 + c * 0.787 - s * 0.213, 0.715 - c * 0.715 - s * 0.715, 0.072 - c * 0.072 + s * 0.928,
    0.213 - c * 0.213 + s * 0.143, 0.715 + c * 0.285 + s * 0.14, 0.072 - c * 0.072 - s * 0.283,
    0.213 - c * 0.213 - s * 0.787, 0.715 - c * 0.715 + s * 0.715, 0.072 + c * 0.928 + s * 0.072,
  ];
}

const SEPIA = [0.393, 0.769, 0.189, 0.349, 0.686, 0.168, 0.272, 0.534, 0.131];
const GRAY = [0.2126, 0.7152, 0.0722, 0.2126, 0.7152, 0.0722, 0.2126, 0.7152, 0.0722];
const diag = (r, g, b) => [r, 0, 0, 0, g, 0, 0, 0, b];

// Devuelve la tubería de color: primero una función lineal (brillo/contraste) y luego una matriz 3x3.
export function colorPipeline(adj = {}) {
  const a = (k) => Number(adj[k]) || 0;
  const B = 1 + a('brightness') / 100;
  const C = 1 + a('contrast') / 100;
  const slope = B * C;
  const intercept = 0.5 - 0.5 * C;
  let M = I3;
  if (a('saturation')) M = mul3(satMatrix(1 + a('saturation') / 100), M);
  if (a('hue')) M = mul3(hueMatrix(a('hue')), M);
  if (a('sepia')) M = mul3(lerpI(SEPIA, a('sepia') / 100), M);
  if (a('grayscale')) M = mul3(lerpI(GRAY, a('grayscale') / 100), M);
  if (a('temperature')) {
    const t = a('temperature') / 100;
    M = mul3(diag(1 + 0.2 * t, 1 + 0.03 * t, 1 - 0.2 * t), M);
  }
  if (a('tint')) {
    const t = a('tint') / 100;
    M = mul3(diag(1 + 0.06 * t, 1 - 0.18 * t, 1 + 0.06 * t), M);
  }
  const hasLinear = Math.abs(slope - 1) > 1e-4 || Math.abs(intercept) > 1e-4;
  const hasMatrix = M.some((v, i) => Math.abs(v - I3[i]) > 1e-4);
  return {
    slope,
    intercept,
    matrix: M,
    hasLinear,
    hasMatrix,
    blur: Math.max(0, a('blur')),
    vignette: Math.max(0, Math.min(1, a('vignette') / 100)),
  };
}

const n5 = (v) => (Math.abs(v) < 1e-9 ? '0' : Number(v.toFixed(5)).toString());

export function colorKey(cp) {
  return [cp.slope, cp.intercept, ...cp.matrix].map(n5).join('_');
}

export function svgMatrixValues(M) {
  return `${n5(M[0])} ${n5(M[1])} ${n5(M[2])} 0 0 ${n5(M[3])} ${n5(M[4])} ${n5(M[5])} 0 0 ${n5(M[6])} ${n5(M[7])} ${n5(M[8])} 0 0 0 0 0 1 0`;
}

export function ffColorFilters(cp) {
  const out = [];
  if (cp.hasLinear) {
    const e = `clip(val*${n5(cp.slope)}+(${n5(cp.intercept * 255)})\\,0\\,255)`;
    out.push(`lutrgb=r=${e}:g=${e}:b=${e}`);
  }
  if (cp.hasMatrix) {
    const M = cp.matrix;
    out.push(
      `colorchannelmixer=rr=${n5(M[0])}:rg=${n5(M[1])}:rb=${n5(M[2])}:gr=${n5(M[3])}:gg=${n5(M[4])}:gb=${n5(M[5])}:br=${n5(M[6])}:bg=${n5(M[7])}:bb=${n5(M[8])}`
    );
  }
  return out;
}

// ---------- Fondo desenfocado (pista principal) ----------
// El mismo clip, ampliado para cubrir el lienzo (+10 %), desenfocado y oscurecido.
export const BG_BLUR = { sigma: 28, darken: 0.72, overscale: 1.1 }; // sigma en px de un lienzo de 1080 de alto

export function bgBlurSigma(PW, PH) {
  return (BG_BLUR.sigma * Math.min(PW, PH)) / 1080;
}

// ---------- Viñeta y máscaras (misma fórmula en canvas y FFmpeg) ----------

export function vignetteAlpha(nx, ny, strength) {
  const d = Math.hypot(nx, ny) / Math.SQRT2;
  const k = Math.min(1, Math.max(0, (d - 0.3) / 0.7));
  return strength * k * k;
}

export function ffVignetteAlphaExpr(strength) {
  return `255*${n5(strength)}*pow(clip((hypot((X+0.5)/W*2-1\\,(Y+0.5)/H*2-1)/sqrt(2)-0.3)/0.7\\,0\\,1)\\,2)`;
}

export const MASKS = [
  { id: 'none', name: 'Ninguna' },
  { id: 'circle', name: 'Círculo' },
  { id: 'rounded', name: 'Redondeada' },
];

export const roundedRadius = (w, h) => Math.min(w, h) * 0.12;

export function ffMaskExpr(type) {
  if (type === 'circle') return `255*clip(min(W\\,H)/2-hypot(X+0.5-W/2\\,Y+0.5-H/2)+0.5\\,0\\,1)`;
  if (type === 'rounded') {
    const r = 'min(W\\,H)*0.12';
    return `255*clip(${r}-hypot(max(abs(X+0.5-W/2)-(W/2-${r})\\,0)\\,max(abs(Y+0.5-H/2)-(H/2-${r})\\,0))+0.5\\,0\\,1)`;
  }
  return null;
}

// ---------- Curvas de animación ----------

export const EASE = {
  linear: { js: (p) => p, ff: (P) => P },
  out: { js: (p) => 1 - Math.pow(1 - p, 3), ff: (P) => `(1-pow(1-${P}\\,3))` },
  in: { js: (p) => p * p * p, ff: (P) => `pow(${P}\\,3)` },
  inout: {
    js: (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2),
    ff: (P) => `if(lt(${P}\\,0.5)\\,4*pow(${P}\\,3)\\,1-pow(2-2*${P}\\,3)/2)`,
  },
  back: {
    js: (p) => 1 + 2.70158 * Math.pow(p - 1, 3) + 1.70158 * Math.pow(p - 1, 2),
    ff: (P) => `(1+2.70158*pow(${P}-1\\,3)+1.70158*pow(${P}-1\\,2))`,
  },
};

export const ANIMS_IN = [
  { id: 'none', name: 'Ninguna' },
  { id: 'fade', name: 'Aparecer' },
  { id: 'slide-left', name: 'Desde la izquierda' },
  { id: 'slide-right', name: 'Desde la derecha' },
  { id: 'slide-up', name: 'Desde abajo' },
  { id: 'slide-down', name: 'Desde arriba' },
  { id: 'zoom-in', name: 'Acercar' },
  { id: 'zoom-out', name: 'Alejar' },
  { id: 'pop', name: 'Rebote' },
];

export const ANIMS_OUT = [
  { id: 'none', name: 'Ninguna' },
  { id: 'fade', name: 'Desvanecer' },
  { id: 'slide-left', name: 'Hacia la izquierda' },
  { id: 'slide-right', name: 'Hacia la derecha' },
  { id: 'slide-up', name: 'Hacia arriba' },
  { id: 'slide-down', name: 'Hacia abajo' },
  { id: 'zoom-in', name: 'Acercar' },
  { id: 'zoom-out', name: 'Alejar' },
];

export const KENBURNS = [
  { id: 'none', name: 'Ninguno' },
  { id: 'zoom-in', name: 'Acercamiento lento' },
  { id: 'zoom-out', name: 'Alejamiento lento' },
];

// Efectos de clip (como los de CapCut para «edits»). intensity va de 0.1 a 1. Un clip puede tener varios.
export const EFFECTS = [
  { id: 'shake', name: 'Temblor', hint: 'La imagen tiembla todo el clip' },
  { id: 'impact', name: 'Impacto', hint: 'Sacudida fuerte al empezar que se calma' },
  { id: 'zoom-hit', name: 'Golpe de zoom', hint: 'Acercamiento rápido al empezar el clip' },
  { id: 'zoom-pulse', name: 'Pulso al ritmo', hint: 'Golpes de zoom repetidos (siguen los marcadores de ritmo)' },
  { id: 'flash', name: 'Destello', hint: 'Fogonazo blanco al empezar el clip' },
];
export const FLASH_DURATION = 0.3;

// Ondas de los temblores (peso, Hz, fase): suma de senos que parece aleatoria pero se repite igual al exportar.
const SHAKE_X = [
  [0.55, 9.3, 0],
  [0.3, 14.7, 1.9],
  [0.15, 23.1, 4.1],
];
const SHAKE_Y = [
  [0.55, 10.7, 2.2],
  [0.3, 16.3, 0.7],
  [0.15, 25.9, 5.3],
];

// Añade al movimiento del clip los efectos que lo mueven o lo escalan (el destello se dibuja aparte).
function effectMotion(m, clip, D, W, H) {
  const minWH = Math.min(W, H);
  for (const fx of clip.effects || []) {
    const i = clamp01(Number(fx.intensity ?? 0.5)) || 0.5;
    if (fx.type === 'shake') {
      const amp = i * 0.035 * minWH;
      m.dx.push({ kind: 'wave', t0: 0, d: D, amp, waves: SHAKE_X, tau: 0 });
      m.dy.push({ kind: 'wave', t0: 0, d: D, amp, waves: SHAKE_Y, tau: 0 });
      // Un poco más grande para que al moverse no se vean los bordes.
      m.scale.push({ t0: 0, d: D, from: 1 + (2 * amp) / minWH, to: 1 + (2 * amp) / minWH, ease: 'linear' });
    } else if (fx.type === 'impact') {
      const amp = i * 0.06 * minWH;
      const d = Math.min(D, 1);
      m.dx.push({ kind: 'wave', t0: 0, d, amp, waves: SHAKE_X, tau: 0.15 });
      m.dy.push({ kind: 'wave', t0: 0, d, amp, waves: SHAKE_Y, tau: 0.15 });
      m.scale.push({ kind: 'pulse', t0: 0, d, amp: (2 * amp) / minWH, tau: 0.15, period: 0, phase: 0 });
    } else if (fx.type === 'zoom-hit') {
      m.scale.push({ kind: 'pulse', t0: 0, d: Math.min(D, 1.2), amp: 0.3 * i, tau: 0.12, period: 0, phase: 0 });
    } else if (fx.type === 'zoom-pulse') {
      const period = Number(fx.period) > 0.15 ? Number(fx.period) : 0.5;
      m.scale.push({ kind: 'pulse', t0: 0, d: D, amp: 0.12 * i, tau: 0.1, period, phase: Number(fx.phase) || 0 });
    }
  }
}

// Opacidad del destello blanco en el tiempo local t del clip (0 si no tiene).
export function flashAlpha(clip, t) {
  const fx = (clip.effects || []).find((e) => e.type === 'flash');
  if (!fx || t < 0 || t >= FLASH_DURATION) return 0;
  const i = clamp01(Number(fx.intensity ?? 0.5)) || 0.5;
  return i * (1 - t / FLASH_DURATION);
}

// Periodo y fase del pulso a partir de los marcadores de ritmo que caen dentro del clip (o null si no hay).
export function beatGridFor(clip, markers = []) {
  const end = clip.start + clip.duration;
  const beats = markers.filter((m) => m.kind === 'beat' && m.t >= clip.start - 1e-3 && m.t <= end + 1e-3).map((m) => m.t);
  if (beats.length < 3) return null;
  const gaps = beats
    .slice(1)
    .map((b, k) => b - beats[k])
    .sort((a, b) => a - b);
  const period = gaps[Math.floor(gaps.length / 2)];
  if (!(period > 0.15)) return null;
  const phase = (((beats[0] - clip.start) % period) + period) % period;
  return { period: Math.round(period * 1000) / 1000, phase: Math.round(phase * 1000) / 1000 };
}

export const TRANSITIONS = [
  { id: 'fade', name: 'Disolver' },
  { id: 'fadeblack', name: 'Fundido' },
  { id: 'slide-left', name: 'Deslizar ←' },
  { id: 'slide-right', name: 'Deslizar →' },
  { id: 'slide-up', name: 'Deslizar ↑' },
  { id: 'slide-down', name: 'Deslizar ↓' },
  { id: 'push-left', name: 'Empujar ←' },
  { id: 'push-right', name: 'Empujar →' },
  { id: 'wipe-left', name: 'Barrido ←' },
  { id: 'wipe-right', name: 'Barrido →' },
  { id: 'circle', name: 'Círculo' },
  { id: 'zoom-in', name: 'Acercar' },
  { id: 'zoom-out', name: 'Alejar' },
];

// ---------- Movimiento ----------
// Un "motion" describe cómo cambia una capa en su tiempo local:
//   fades: [{ type: 'in'|'out', st, d }]           opacidad (lineal, multiplicativa)
//   dx, dy: [{ t0, d, from, to, ease }]             desplazamiento en px del proyecto (suma)
//   scale:  [{ t0, d, from, to, ease }]             escala (producto)
//   reveal: { type: 'wipe-left'|'wipe-right'|'circle', t0, d, ease } (solo transiciones)

export function emptyMotion() {
  return { fades: [], dx: [], dy: [], scale: [], reveal: null };
}

function mergeMotion(a, b) {
  return {
    fades: [...a.fades, ...b.fades],
    dx: [...a.dx, ...b.dx],
    dy: [...a.dy, ...b.dy],
    scale: [...a.scale, ...b.scale],
    reveal: a.reveal || b.reveal,
  };
}

export function motionIsStatic(m) {
  return !m.fades.length && !m.dx.length && !m.dy.length && !m.scale.length && !m.reveal;
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// Animaciones propias del clip (entrada, salida y Ken Burns). D = duración del clip; W,H = lienzo del proyecto.
export function clipMotion(clip, D, W, H) {
  const m = emptyMotion();
  const types = { in: clip.animIn?.type || 'none', out: clip.animOut?.type || 'none' };
  let dIn = types.in !== 'none' ? Math.max(0.05, Number(clip.animIn.duration) || 0.5) : 0;
  let dOut = types.out !== 'none' ? Math.max(0.05, Number(clip.animOut.duration) || 0.5) : 0;
  if (dIn + dOut > D) {
    const k = D / (dIn + dOut);
    dIn *= k;
    dOut *= k;
  }
  switch (types.in) {
    case 'fade': m.fades.push({ type: 'in', st: 0, d: dIn }); break;
    case 'slide-left': m.dx.push({ t0: 0, d: dIn, from: -W, to: 0, ease: 'out' }); break;
    case 'slide-right': m.dx.push({ t0: 0, d: dIn, from: W, to: 0, ease: 'out' }); break;
    case 'slide-up': m.dy.push({ t0: 0, d: dIn, from: H, to: 0, ease: 'out' }); break;
    case 'slide-down': m.dy.push({ t0: 0, d: dIn, from: -H, to: 0, ease: 'out' }); break;
    case 'zoom-in':
      m.scale.push({ t0: 0, d: dIn, from: 0.3, to: 1, ease: 'out' });
      m.fades.push({ type: 'in', st: 0, d: dIn });
      break;
    case 'zoom-out':
      m.scale.push({ t0: 0, d: dIn, from: 1.6, to: 1, ease: 'out' });
      m.fades.push({ type: 'in', st: 0, d: dIn });
      break;
    case 'pop':
      m.scale.push({ t0: 0, d: dIn, from: 0.4, to: 1, ease: 'back' });
      m.fades.push({ type: 'in', st: 0, d: dIn * 0.5 });
      break;
    default: break;
  }
  const s = D - dOut;
  switch (types.out) {
    case 'fade': m.fades.push({ type: 'out', st: s, d: dOut }); break;
    case 'slide-left': m.dx.push({ t0: s, d: dOut, from: 0, to: -W, ease: 'in' }); break;
    case 'slide-right': m.dx.push({ t0: s, d: dOut, from: 0, to: W, ease: 'in' }); break;
    case 'slide-up': m.dy.push({ t0: s, d: dOut, from: 0, to: -H, ease: 'in' }); break;
    case 'slide-down': m.dy.push({ t0: s, d: dOut, from: 0, to: H, ease: 'in' }); break;
    case 'zoom-in':
      m.scale.push({ t0: s, d: dOut, from: 1, to: 1.6, ease: 'in' });
      m.fades.push({ type: 'out', st: s, d: dOut });
      break;
    case 'zoom-out':
      m.scale.push({ t0: s, d: dOut, from: 1, to: 0.3, ease: 'in' });
      m.fades.push({ type: 'out', st: s, d: dOut });
      break;
    default: break;
  }
  if (clip.kenburns === 'zoom-in') m.scale.push({ t0: 0, d: D, from: 1, to: 1.25, ease: 'linear' });
  if (clip.kenburns === 'zoom-out') m.scale.push({ t0: 0, d: D, from: 1.25, to: 1, ease: 'linear' });
  effectMotion(m, clip, D, W, H);
  return m;
}

// Efecto de una transición de duración d entre A (sale) y B (entra), en tiempo local de la transición u ∈ [0, d].
export function transitionFx(type, d, W, H) {
  const A = emptyMotion();
  const B = emptyMotion();
  let top = 'B';
  switch (type) {
    case 'fadeblack':
      A.fades.push({ type: 'out', st: 0, d: d / 2 });
      B.fades.push({ type: 'in', st: d / 2, d: d / 2 });
      break;
    case 'slide-left': B.dx.push({ t0: 0, d, from: W, to: 0, ease: 'out' }); break;
    case 'slide-right': B.dx.push({ t0: 0, d, from: -W, to: 0, ease: 'out' }); break;
    case 'slide-up': B.dy.push({ t0: 0, d, from: H, to: 0, ease: 'out' }); break;
    case 'slide-down': B.dy.push({ t0: 0, d, from: -H, to: 0, ease: 'out' }); break;
    case 'push-left':
      A.dx.push({ t0: 0, d, from: 0, to: -W, ease: 'inout' });
      B.dx.push({ t0: 0, d, from: W, to: 0, ease: 'inout' });
      break;
    case 'push-right':
      A.dx.push({ t0: 0, d, from: 0, to: W, ease: 'inout' });
      B.dx.push({ t0: 0, d, from: -W, to: 0, ease: 'inout' });
      break;
    case 'wipe-left':
    case 'wipe-right':
    case 'circle':
      B.reveal = { type, t0: 0, d, ease: 'inout' };
      break;
    case 'zoom-in':
      B.scale.push({ t0: 0, d, from: 0.6, to: 1, ease: 'out' });
      B.fades.push({ type: 'in', st: 0, d });
      break;
    case 'zoom-out':
      top = 'A';
      A.scale.push({ t0: 0, d, from: 1, to: 1.4, ease: 'in' });
      A.fades.push({ type: 'out', st: 0, d });
      break;
    case 'fade':
    default:
      B.fades.push({ type: 'in', st: 0, d });
      break;
  }
  return { A, B, top };
}

// ----- Evaluación numérica (vista previa) -----
// Además de los tramos «de A a B», hay dos tipos para los efectos:
//   wave:  { t0, d, amp, waves: [[peso, Hz, fase]], tau }  desplazamiento que oscila (se apaga con tau si tau > 0)
//   pulse: { t0, d, amp, tau, period, phase }             escala 1 + amp·e^(−u/tau); u se reinicia cada period

function waveValue(seg, t) {
  if (t < seg.t0 || t > seg.t0 + seg.d) return 0;
  const u = t - seg.t0;
  let s = 0;
  for (const [w, f, ph] of seg.waves) s += w * Math.sin(2 * Math.PI * f * u + ph);
  return seg.amp * (seg.tau > 0 ? Math.exp(-u / seg.tau) : 1) * s;
}

function pulseValue(seg, t) {
  if (t < seg.t0 || t > seg.t0 + seg.d) return 1;
  let u = t - seg.t0;
  if (seg.period > 0) u = (((u - seg.phase) % seg.period) + seg.period) % seg.period;
  return 1 + seg.amp * Math.exp(-u / seg.tau);
}

function segValue(seg, t) {
  if (seg.kind === 'wave') return waveValue(seg, t);
  if (seg.kind === 'pulse') return pulseValue(seg, t);
  const p = clamp01((t - seg.t0) / seg.d);
  return seg.from + (seg.to - seg.from) * EASE[seg.ease || 'linear'].js(p);
}

export function evalMotion(m, t) {
  let alpha = 1;
  for (const f of m.fades) {
    const p = clamp01((t - f.st) / f.d);
    alpha *= f.type === 'in' ? p : 1 - p;
  }
  let dx = 0;
  let dy = 0;
  let scale = 1;
  for (const s of m.dx) dx += segValue(s, t);
  for (const s of m.dy) dy += segValue(s, t);
  for (const s of m.scale) scale *= segValue(s, t);
  let reveal = null;
  if (m.reveal) reveal = { type: m.reveal.type, p: EASE[m.reveal.ease].js(clamp01((t - m.reveal.t0) / m.reveal.d)) };
  return { alpha, dx, dy, scale, reveal };
}

// ----- Expresiones de FFmpeg (exportación) -----
// tv: expresión del tiempo local (p. ej. 't' o '(t-12.5)'); k: escala de píxeles proyecto → salida.

function ffSeg(seg, tv, k = 1) {
  const inside = `between(${tv}\\,${n5(seg.t0)}\\,${n5(seg.t0 + seg.d)})`;
  const U = `(${tv}-${n5(seg.t0)})`;
  if (seg.kind === 'wave') {
    const sum = seg.waves.map(([w, f, ph]) => `${n5(w)}*sin(${n5(2 * Math.PI * f)}*${U}+${n5(ph)})`).join('+');
    const decay = seg.tau > 0 ? `*exp(-${U}/${n5(seg.tau)})` : '';
    return `(${n5(seg.amp * k)}*${inside}${decay}*(${sum}))`;
  }
  if (seg.kind === 'pulse') {
    const u = seg.period > 0 ? `mod(${U}-${n5(seg.phase)}+${n5(seg.period * 1000)}\\,${n5(seg.period)})` : U;
    return `(1+${n5(seg.amp)}*${inside}*exp(-${u}/${n5(seg.tau)}))`;
  }
  const P = `clip((${tv}-${n5(seg.t0)})/${n5(seg.d)}\\,0\\,1)`;
  const E = EASE[seg.ease || 'linear'].ff(P);
  return `((${n5(seg.from * k)})+(${n5((seg.to - seg.from) * k)})*${E})`;
}

export function ffMotionExprs(m, tv, k) {
  return {
    dx: m.dx.length ? m.dx.map((s) => ffSeg(s, tv, k)).join('+') : null,
    dy: m.dy.length ? m.dy.map((s) => ffSeg(s, tv, k)).join('+') : null,
    scale: m.scale.length ? m.scale.map((s) => ffSeg(s, tv, 1)).join('*') : null,
  };
}

export function ffFadeFilters(m) {
  return m.fades.map((f) => `fade=t=${f.type}:st=${n5(f.st)}:d=${n5(Math.max(0.001, f.d))}:alpha=1`);
}

// Máscara de revelado (en la variable T de geq) para barridos y círculo.
export function ffRevealExpr(reveal) {
  const P = `clip((T-${n5(reveal.t0)})/${n5(reveal.d)}\\,0\\,1)`;
  const E = EASE[reveal.ease || 'inout'].ff(P);
  if (reveal.type === 'wipe-left') return `255*clip((X-W*(1-${E}))/2+0.5\\,0\\,1)`;
  if (reveal.type === 'wipe-right') return `255*clip((W*${E}-X)/2+0.5\\,0\\,1)`;
  return `255*clip((hypot(W\\,H)/2*${E}-hypot(X-W/2\\,Y-H/2))/2+0.5\\,0\\,1)`;
}

export { n5 as fmtNum };
