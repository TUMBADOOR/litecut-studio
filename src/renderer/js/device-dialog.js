// Ventana «Rendimiento de este equipo»: lo que la app detectó y cómo se adapta a él.
import { h, modal, toggleRow } from './ui.js';
import { icon } from './icons.js';
import { deviceProfile, hwDecodes, CODEC_NAMES } from './device.js';
import { media } from './media.js';

const TIER = { low: 'Equipo modesto', mid: 'Equipo intermedio', high: 'Equipo potente' };
const ENCODERS = {
  h264_qsv: 'Intel Quick Sync',
  h264_nvenc: 'NVIDIA NVENC',
  h264_amf: 'AMD AMF',
  h264_mf: 'Media Foundation',
  h264_videotoolbox: 'Apple VideoToolbox',
};

const gb = (x) => `${(x || 0).toFixed(1).replace('.', ',')} GB`;

export async function showDeviceDialog() {
  const p = await deviceProfile();
  const codecs = ['h264', 'hevc', 'vp9', 'av1'];
  const dec = await Promise.all(codecs.map((c) => hwDecodes(c, 1920, 1080, 30)));
  const noHw = codecs.filter((_, i) => !dec[i]).map((c) => CODEC_NAMES[c]);
  const row = (k, ...v) => h('div', { class: 'dv-row' }, h('span', { class: 'dv-k' }, k), h('span', { class: 'dv-v' }, ...v));
  const chip = (ok, name) => h('span', { class: `dv-chip ${ok ? 'ok' : 'no'}`, html: `${icon(ok ? 'check' : 'close', 12)}${name}` });
  const body = h(
    'div',
    { class: 'device' },
    row('Procesador', `${p.cpu || 'Desconocido'} · ${p.cores} núcleos`),
    row('Memoria', `${gb(p.ramGB)} · libre ahora ${gb(p.freeRamGB)}`),
    row('Gráfica', p.gpu || 'Desconocida'),
    row('Video por hardware', h('span', { class: 'dv-chips' }, ...codecs.map((c, i) => chip(dec[i], CODEC_NAMES[c])))),
    row('Exportación acelerada', p.hwEncoder ? ENCODERS[p.hwEncoder] || p.hwEncoder : 'No disponible (usa el procesador)'),
    row('Tipo de equipo', TIER[p.tier] || TIER.mid),
    h('h3', {}, 'Cómo se adapta LiteCut'),
    h(
      'ul',
      {},
      h('li', {}, `Los videos que la gráfica no decodifica${noHw.length ? ` (${noHw.join(', ')})` : ''} o que son demasiado grandes para este equipo se editan con una copia ligera de 720p. Al exportar se usa siempre el original.`),
      h('li', {}, 'Mientras la ventana está activa, LiteCut tiene prioridad sobre los demás programas para que la imagen y el sonido no se traben.'),
      h('li', {}, 'Las miniaturas, las ondas de audio y las copias ligeras se crean en segundo plano con prioridad baja.'),
      h('li', {}, 'Si un video tarda en cargar, la reproducción espera un instante en lugar de saltar y cortar el audio.')
    ),
    toggleRow({
      label: 'Crear copias ligeras de los videos pesados (recomendado)',
      value: media.prefs.autoOptimize,
      onChange: (v) => media.setAutoOptimize(v),
    }),
    p.freeRamGB < 0.6
      ? h('p', { class: 'dv-warn', html: `${icon('alert', 14)}<span>Ahora quedan ${gb(p.freeRamGB)} de memoria libre. Cierra los programas que no uses (juegos, navegador…) para que todo vaya más fluido.</span>` })
      : null
  );
  modal({ title: 'Rendimiento de este equipo', body, width: 580 });
}
