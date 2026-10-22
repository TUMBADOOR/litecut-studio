// Ventana «Conectar con IA»: activa la conexión local (servidor MCP) y da la configuración lista para copiar
// en Claude Desktop, Gemini CLI u otras apps compatibles con MCP. La IA usa la cuenta del propio usuario.
import { h, modal, btn, segmented, toggleRow, toast, alertDialog } from './ui.js';
import { icon } from './icons.js';

const api = window.api;

const EXAMPLES = [
  'Importa C:\\Users\\yo\\Videos\\clase.mp4, corta los silencios, pon el título «Clase 1» y expórtalo en 9:16.',
  '¿Qué se ve en el segundo 12 de mi proyecto? Si el título tapa algo, súbelo.',
  'Aplica el filtro Cine a todos los clips y pon una transición de disolver entre cada uno.',
];

export function clientLabel(name = '') {
  if (/claude/i.test(name)) return 'Claude';
  if (/gemini/i.test(name)) return 'Gemini';
  if (/cursor/i.test(name)) return 'Cursor';
  if (/copilot|vscode|visual studio/i.test(name)) return 'VS Code';
  return name || 'una app de IA';
}

const quote = (s) => `"${s}"`;
const snippet = (cfg, extra = {}) => JSON.stringify({ mcpServers: { litecut: { command: cfg.command, args: cfg.args, env: cfg.env, ...extra } } }, null, 2);

function codeBox(text) {
  return h(
    'div',
    { class: 'ai-code' },
    h('pre', {}, text),
    btn('Copiar', {
      kind: 'small',
      icon: 'copy',
      onClick: async () => {
        await api.ai.copy(text);
        toast('Copiado', { timeout: 1400 });
      },
    })
  );
}

function installButton(target, label) {
  const out = h('span', { class: 'ai-install-msg' });
  const b = btn(label, {
    kind: 'small primary',
    icon: 'wand',
    onClick: async () => {
      b.disabled = true;
      const r = await api.ai.install(target);
      b.disabled = false;
      if (!r.ok) {
        alertDialog('No se pudo configurar automáticamente', r.error);
        return;
      }
      out.textContent = `Listo: ${r.files.map((f) => f.file).join(', ')}`;
      toast(target === 'claude' ? 'Claude Desktop configurado. Ciérralo por completo y vuelve a abrirlo.' : 'Gemini CLI configurado. Abre «gemini» de nuevo.', { timeout: 7000 });
    },
  });
  return h('div', { class: 'ai-row' }, b, out);
}

export async function openAiDialog() {
  let st = await api.ai.status();
  let tab = localStorage.getItem('litecut.aiTab') || 'claude';
  const cfg = st.config;
  const cmdLine = [cfg.command, ...cfg.args].map(quote).join(' ');

  const stateEl = h('div', { class: 'ai-state' });
  const toggle = toggleRow({
    label: 'Permitir que las apps de IA de este equipo usen LiteCut',
    value: st.enabled,
    onChange: async (v) => {
      st = await api.ai.setEnabled(v);
      if (st.error) alertDialog('No se pudo activar la conexión', st.error);
      renderState();
    },
  });
  const renderState = () => {
    toggle.setValue(st.enabled);
    const names = [...new Set(st.clients.map((c) => clientLabel(c.title || c.name)))];
    stateEl.className = `ai-state${st.enabled ? (names.length ? ' linked' : ' ready') : ''}`;
    stateEl.replaceChildren(
      h('i'),
      h('span', {}, !st.enabled ? 'Desactivada: ninguna app puede usar LiteCut.' : names.length ? `Conectada: ${names.join(', ')}.` : 'Activada: esperando a tu app de IA.')
    );
  };

  const tabBody = h('div', { class: 'ai-tab' });
  const renderTab = () => {
    localStorage.setItem('litecut.aiTab', tab);
    if (tab === 'claude') {
      tabBody.replaceChildren(
        h(
          'ol',
          { class: 'ai-steps' },
          h('li', {}, 'Instala ', h('b', {}, 'Claude Desktop'), ' (claude.ai/download) y entra con tu cuenta. Funciona también con el plan gratuito.'),
          h('li', {}, 'Pulsa el botón para añadir LiteCut a su configuración:', installButton('claude', 'Configurar Claude Desktop'), h('span', { class: 'hint' }, 'O hazlo a mano: en Claude Desktop, Configuración › Desarrollador › Editar configuración, y pega esto en el archivo:'), codeBox(snippet(cfg))),
          h('li', {}, 'Cierra Claude Desktop por completo (también desde el ícono junto al reloj) y vuelve a abrirlo. «litecut» aparecerá entre sus herramientas.')
        )
      );
    } else if (tab === 'gemini') {
      tabBody.replaceChildren(
        h(
          'ol',
          { class: 'ai-steps' },
          h('li', {}, 'Instala ', h('b', {}, 'Gemini CLI'), ' (necesita Node.js): ', h('code', {}, 'npm install -g @google/gemini-cli'), '. Ábrelo una vez con ', h('code', {}, 'gemini'), ' y entra con tu cuenta de Google (tiene nivel gratuito).'),
          h('li', {}, 'Pulsa el botón para añadir LiteCut a su configuración:', installButton('gemini', 'Configurar Gemini CLI'), h('span', { class: 'hint' }, `O pega esto en ${st.files.gemini}:`), codeBox(snippet(cfg, { timeout: 600000 }))),
          h('li', {}, 'Vuelve a abrir ', h('code', {}, 'gemini'), ' y escribe ', h('code', {}, '/mcp'), ' para comprobar que aparece «litecut».')
        )
      );
    } else {
      tabBody.replaceChildren(
        h('p', { class: 'dialog-text' }, 'Cualquier app compatible con MCP (Cursor, Windsurf, LM Studio, VS Code, Claude Code…) puede usar LiteCut como servidor local por stdio. Configuración habitual:'),
        codeBox(snippet(cfg)),
        h('p', { class: 'hint' }, 'Si la app pide un comando: ejecuta lo siguiente con la variable de entorno ELECTRON_RUN_AS_NODE=1.'),
        codeBox(cmdLine),
        h('p', { class: 'hint' }, 'En Claude Code:'),
        codeBox(`claude mcp add litecut -e ELECTRON_RUN_AS_NODE=1 -- ${cmdLine}`)
      );
    }
  };

  const examples = h(
    'div',
    { class: 'ai-examples' },
    ...EXAMPLES.map((text) => {
      const b = h('button', { class: 'ai-example', type: 'button', title: 'Copiar' }, h('span', { html: icon('sparkles', 14) }), h('span', {}, text));
      b.addEventListener('click', async () => {
        await api.ai.copy(text);
        toast('Ejemplo copiado: pégalo en tu app de IA', { timeout: 1800 });
      });
      return b;
    })
  );

  const body = h(
    'div',
    { class: 'ai-dialog' },
    h('p', { class: 'dialog-text' }, 'Pide a tu asistente de IA (Claude, Gemini u otro compatible con MCP) que importe, corte, titule y exporte tus videos en LiteCut, con tu propia cuenta. La conexión es solo dentro de este equipo: no se abre a internet ni a tu red.'),
    toggle,
    stateEl,
    st.portable ? h('p', { class: 'dv-warn', html: `${icon('alert', 14)}<span>Estás usando la versión portable, que cambia de carpeta cada vez que se abre. Para conectar tu IA, instala LiteCut con el instalador.</span>` }) : null,
    segmented({
      options: [
        { value: 'claude', label: 'Claude Desktop' },
        { value: 'gemini', label: 'Gemini CLI' },
        { value: 'other', label: 'Otras apps' },
      ],
      value: tab,
      onChange: (v) => {
        tab = v;
        renderTab();
      },
    }),
    tabBody,
    h('h3', {}, 'Pídele, por ejemplo'),
    examples,
    h('p', { class: 'hint' }, 'Tu app de IA ve los datos del proyecto y los fotogramas que pide, y los envía a su proveedor (Anthropic, Google…) según tu cuenta. Cada cambio que hace se deshace con Ctrl+Z.')
  );
  renderState();
  renderTab();
  const off = api.ai.onStatus((s) => {
    st = s;
    renderState();
  });
  modal({ title: 'Conectar con IA', body, width: 700, className: 'ai-modal', onClose: () => off() });
}
