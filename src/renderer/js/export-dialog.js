// Diálogo de exportación: formato, resolución, calidad, aceleración por GPU y progreso.
import { store } from './store.js';
import { h, modal, segmented, selectRow, toggleRow, btn, toast, fmtBytes, fmtEta, alertDialog } from './ui.js';
import { icon } from './icons.js';
import { projectDuration, formatTime } from '../shared/model.js';
import { textClipsToRender } from '../shared/export-graph.js';
import { textToPngBuffer } from './text-render.js';

const api = window.api;
const even = (v) => Math.max(2, Math.round(v / 2) * 2);

const HW_NAMES = {
  h264_qsv: 'Intel Quick Sync',
  hevc_qsv: 'Intel Quick Sync',
  h264_nvenc: 'NVIDIA NVENC',
  hevc_nvenc: 'NVIDIA NVENC',
  h264_amf: 'AMD AMF',
  hevc_amf: 'AMD AMF',
  h264_mf: 'Windows Media Foundation',
  hevc_mf: 'Windows Media Foundation',
  h264_videotoolbox: 'Apple VideoToolbox',
  hevc_videotoolbox: 'Apple VideoToolbox',
};

export const FORMATS = [
  { id: 'mp4', label: 'MP4', ext: 'mp4', desc: 'Video H.264 — compatible con todo (YouTube, WhatsApp, TikTok…)' },
  { id: 'mp4-hevc', label: 'MP4 H.265', ext: 'mp4', desc: 'Archivo más pequeño con la misma calidad (equipos recientes)' },
  { id: 'webm', label: 'WebM', ext: 'webm', desc: 'Formato web abierto (VP9)' },
  { id: 'gif', label: 'GIF', ext: 'gif', desc: 'Animación sin sonido, ideal para clips cortos' },
  { id: 'mp3', label: 'MP3', ext: 'mp3', desc: 'Solo el audio' },
  { id: 'wav', label: 'WAV', ext: 'wav', desc: 'Solo el audio, sin compresión' },
];

export function resolutionOptions(PW, PH, gif) {
  const short = Math.min(PW, PH);
  const out = [];
  const add = (label, w, h) => {
    if (!out.some((o) => o.w === w && o.h === h)) out.push({ value: `${w}x${h}`, label: `${label} — ${w}×${h}`, w, h });
  };
  if (gif) {
    for (const w of [320, 480, 640, 800]) {
      const s = w / Math.max(PW, PH);
      add(`${w} px`, even(PW * s), even(PH * s));
    }
    return out;
  }
  add('Proyecto', even(PW), even(PH));
  for (const [label, target] of [['4K', 2160], ['1440p', 1440], ['1080p', 1080], ['720p', 720], ['480p', 480], ['360p', 360]]) {
    if (target > short * 2) continue;
    const s = target / short;
    add(label, even(PW * s), even(PH * s));
  }
  return out;
}

// Textos → PNG a la escala de salida (la exportación los superpone tal como se ven en la vista previa).
export async function renderTextAssets(project, outWidth) {
  const assets = { text: {} };
  const k = outWidth / project.settings.width;
  for (const c of textClipsToRender(project)) {
    try {
      const r = await textToPngBuffer(c.text, k * (c.transform.scale || 1));
      const path = await api.fs.writeTemp(`texto_${c.id}.png`, r.buffer);
      assets.text[c.id] = { path, w: r.w, h: r.h };
    } catch (err) {
      console.error(err);
    }
  }
  return assets;
}

export async function openExportDialog({ player }) {
  const p = store.project;
  const duration = projectDuration(p);
  if (!p.clips.length || duration <= 0) {
    toast('Añade clips a la línea de tiempo antes de exportar', { timeout: 2600 });
    return;
  }
  const missing = p.clips.map((c) => c.mediaId && store.getMedia(c.mediaId)).filter((m) => m && m.missing);
  if (missing.length) {
    await alertDialog('Faltan archivos', 'Algunos clips usan archivos que se movieron o eliminaron. Vuelve a enlazarlos desde la biblioteca (clic derecho › Buscar archivo…) antes de exportar.', [...new Set(missing.map((m) => m.path))].join('\n'));
    return;
  }
  player.pause();
  const [info, caps] = await Promise.all([api.app.info(), api.exporter.caps().catch(() => ({ hw: {} }))]);
  const hw = caps.hw || {};
  const st = {
    name: p.name && p.name !== 'Proyecto sin título' ? p.name : 'Mi video',
    dir: localStorage.getItem('litecut.exportDir') || info.paths.videos,
    format: localStorage.getItem('litecut.exportFormat') || 'mp4',
    res: null,
    fps: p.settings.fps,
    quality: localStorage.getItem('litecut.exportQuality') || 'medium',
    useHardware: localStorage.getItem('litecut.exportHw') !== '0',
  };
  if (st.format === 'mp4-hevc' && !hw.hevc && !hw.software?.x265) st.format = 'mp4';

  const body = h('div', { class: 'export-body' });
  const m = modal({ title: 'Exportar video', body, width: 620, className: 'export-modal' });
  const render = () => {
    body.innerHTML = '';
    const fmt = FORMATS.find((f) => f.id === st.format) || FORMATS[0];
    const isGif = fmt.id === 'gif';
    const audioOnly = fmt.id === 'mp3' || fmt.id === 'wav';
    const resOpts = resolutionOptions(p.settings.width, p.settings.height, isGif);
    if (!st.res || !resOpts.some((o) => o.value === st.res)) st.res = (isGif ? resOpts[1] : resOpts[0]).value;
    const res = resOpts.find((o) => o.value === st.res);
    const fps = isGif ? Math.min(st.fps, 15) : st.fps;
    const name = h('input', { type: 'text', value: st.name, class: 'wide-input' });
    name.addEventListener('input', () => (st.name = name.value));
    const dirLabel = h('span', { class: 'path' }, st.dir);
    const change = btn('Cambiar…', {
      kind: 'small',
      onClick: async () => {
        const out = await api.dialog.exportPath({ name: st.name, ext: fmt.ext, dir: st.dir });
        if (out) {
          const sep = out.includes('\\') ? '\\' : '/';
          st.dir = out.slice(0, out.lastIndexOf(sep));
          st.name = out.slice(out.lastIndexOf(sep) + 1).replace(/\.[^.]+$/, '');
          st.confirmedPath = out;
          render();
        }
      },
    });
    const hwEnc = fmt.id === 'mp4' ? hw.h264 : fmt.id === 'mp4-hevc' ? hw.hevc : null;
    const kb = (() => {
      if (audioOnly) return fmt.id === 'wav' ? 1411 : { high: 256, medium: 192, low: 128 }[st.quality];
      const bpp = { high: 0.11, medium: 0.07, low: 0.045 }[st.quality] * (fmt.id === 'mp4-hevc' ? 0.6 : fmt.id === 'webm' ? 0.75 : isGif ? 2.5 : 1);
      return (res.w * res.h * fps * bpp) / 1000 + (isGif ? 0 : 160);
    })();
    const size = (kb * 1000 * duration) / 8;

    body.append(
      h('div', { class: 'ex-row' }, h('label', {}, 'Nombre'), name),
      h('div', { class: 'ex-row' }, h('label', {}, 'Guardar en'), h('div', { class: 'ex-path' }, dirLabel, change)),
      h(
        'div',
        { class: 'ex-row' },
        h('label', {}, 'Formato'),
        h(
          'div',
          {},
          segmented({
            options: FORMATS.filter((f) => f.id !== 'mp4-hevc' || hw.hevc || hw.software?.x265).map((f) => ({ value: f.id, label: f.label })),
            value: fmt.id,
            onChange: (v) => {
              st.format = v;
              st.confirmedPath = null;
              localStorage.setItem('litecut.exportFormat', v);
              render();
            },
          }),
          h('p', { class: 'hint' }, fmt.desc)
        )
      )
    );
    if (!audioOnly) {
      body.append(
        selectRow({
          label: 'Resolución',
          value: st.res,
          options: resOpts,
          onChange: (v) => {
            st.res = v;
            render();
          },
        }),
        selectRow({
          label: 'Fotogramas/s',
          value: fps,
          options: (isGif ? [10, 12, 15] : [24, 25, 30, 50, 60]).map((v) => ({ value: v, label: `${v} fps` })),
          onChange: (v) => {
            st.fps = +v;
            render();
          },
        })
      );
    }
    if (!isGif) {
      body.append(
        h(
          'div',
          { class: 'ex-row' },
          h('label', {}, 'Calidad'),
          segmented({
            options: [
              { value: 'high', label: 'Alta' },
              { value: 'medium', label: 'Recomendada' },
              { value: 'low', label: 'Liviana' },
            ],
            value: st.quality,
            onChange: (v) => {
              st.quality = v;
              localStorage.setItem('litecut.exportQuality', v);
              render();
            },
          })
        )
      );
    }
    if (fmt.id === 'mp4' || fmt.id === 'mp4-hevc') {
      body.append(
        toggleRow({
          label: hwEnc ? `Usar la tarjeta gráfica (${HW_NAMES[hwEnc] || hwEnc}) — mucho más rápido` : 'Aceleración por hardware (no disponible en este equipo)',
          value: st.useHardware && !!hwEnc,
          onChange: (v) => {
            st.useHardware = v;
            localStorage.setItem('litecut.exportHw', v ? '1' : '0');
          },
        })
      );
    }
    body.append(
      h(
        'div',
        { class: 'ex-summary' },
        h('div', {}, h('span', {}, 'Duración'), h('b', {}, formatTime(duration, fps))),
        audioOnly ? null : h('div', {}, h('span', {}, 'Tamaño de salida'), h('b', {}, `${res.w}×${res.h}`)),
        h('div', {}, h('span', {}, 'Archivo aprox.'), h('b', {}, `~${fmtBytes(size)}`))
      ),
      h(
        'div',
        { class: 'modal-foot inline' },
        btn('Cancelar', { onClick: () => m.close() }),
        btn('Exportar', {
          kind: 'primary',
          icon: 'export',
          onClick: () => start({ fmt, res, fps, isGif, audioOnly, hwEnc }),
        })
      )
    );
  };

  const start = async ({ fmt, res, fps, isGif, audioOnly, hwEnc }) => {
    let output = st.confirmedPath;
    if (!output) {
      output = await api.dialog.exportPath({ name: st.name || 'Mi video', ext: fmt.ext, dir: st.dir });
      if (!output) return;
    }
    const sep = output.includes('\\') ? '\\' : '/';
    localStorage.setItem('litecut.exportDir', output.slice(0, output.lastIndexOf(sep)));
    const settings = {
      output,
      format: fmt.id,
      width: audioOnly ? p.settings.width : res.w,
      height: audioOnly ? p.settings.height : res.h,
      fps,
      quality: st.quality,
      useHardware: st.useHardware && !!hwEnc,
    };
    // Progreso
    body.innerHTML = '';
    const bar = h('div', { class: 'pbar' }, h('i'));
    const pct = h('div', { class: 'ex-pct' }, '0%');
    const detail = h('div', { class: 'ex-detail' }, 'Preparando…');
    const cancel = btn('Cancelar', {
      onClick: async () => {
        cancel.disabled = true;
        await api.exporter.cancel();
      },
    });
    body.append(h('div', { class: 'ex-progress' }, h('div', { class: 'ex-ic', html: icon('export', 30) }), pct, bar, detail, h('div', { class: 'modal-foot inline' }, cancel)));
    m.overlay.classList.add('busy');

    const assets = audioOnly ? { text: {} } : await renderTextAssets(p, settings.width);
    const t0 = Date.now();
    const off = api.exporter.onProgress((pr) => {
      const v = Math.round((pr.percent || 0) * 1000) / 10;
      pct.textContent = `${v.toFixed(v < 10 ? 1 : 0)}%`;
      bar.firstChild.style.width = `${v}%`;
      const enc = pr.encoder && pr.encoder !== 'cpu' ? `GPU (${HW_NAMES[pr.encoder] || pr.encoder})` : 'CPU';
      detail.textContent = `${formatTime(pr.time || 0, fps)} de ${formatTime(duration, fps)} · ${pr.speed ? `${pr.speed.toFixed(2)}× tiempo real` : '…'} · quedan ${fmtEta(pr.eta)} · ${enc}`;
    });
    const result = await api.exporter.start({ project: JSON.parse(store.serialize()), settings, assets });
    off();
    m.overlay.classList.remove('busy');
    const secs = (Date.now() - t0) / 1000;
    body.innerHTML = '';
    if (result.ok) {
      body.append(
        h(
          'div',
          { class: 'ex-done' },
          h('div', { class: 'ex-ic ok', html: icon('check', 34) }),
          h('h3', {}, '¡Exportación completada!'),
          h('p', { class: 'path' }, result.output),
          h('p', { class: 'hint' }, `Tardó ${fmtEta(secs)}${result.encoder && result.encoder !== 'cpu' ? ` usando ${HW_NAMES[result.encoder] || result.encoder}` : ''}.`),
          h(
            'div',
            { class: 'modal-foot inline' },
            btn('Mostrar en la carpeta', { icon: 'folder', onClick: () => api.shell.showItem(result.output) }),
            btn('Abrir', { icon: 'play', onClick: () => api.shell.openPath(result.output) }),
            btn('Cerrar', { kind: 'primary', onClick: () => m.close() })
          )
        )
      );
    } else if (result.cancelled) {
      toast('Exportación cancelada', { timeout: 2000 });
      render();
    } else {
      body.append(
        h(
          'div',
          { class: 'ex-done' },
          h('div', { class: 'ex-ic err', html: icon('alert', 34) }),
          h('h3', {}, 'No se pudo exportar'),
          h('p', {}, result.error?.message || 'Error desconocido'),
          result.error?.details ? h('pre', { class: 'details' }, result.error.details) : null,
          h('div', { class: 'modal-foot inline' }, btn('Volver', { onClick: () => render() }), btn('Cerrar', { kind: 'primary', onClick: () => m.close() }))
        )
      );
    }
  };
  render();
}
