// Ventana «Ajustes del asistente»: proveedor, modelo, clave (se guarda cifrada en el proceso principal: aquí solo
// se escribe), probar la conexión y qué datos se envían.
import { h, btn, modal, segmented, toggleRow, toast } from './ui.js';
import { icon } from './icons.js';
import { ASSISTANT_PROVIDERS, PROVIDER_MAP } from '../shared/assistant-catalog.js';

const api = window.api;

const ABOUT = {
  gemini: 'Google Gemini tiene un nivel gratuito: entra con tu cuenta de Google en Google AI Studio y crea una clave de API (no pide tarjeta). Tiene un límite de peticiones por minuto y por día.',
  claude: 'Claude, de Anthropic. Crea una clave en la consola de Claude; se paga según el uso (Haiku es el más barato).',
  openai: 'OpenAI. Crea una clave en su plataforma; se paga según el uso.',
  openrouter: 'OpenRouter da acceso a cientos de modelos de varias empresas con una sola clave y un solo saldo (algunos modelos son gratis).',
  ollama:
    'Ollama ejecuta modelos abiertos en tu equipo o en otro de tu red, sin clave ni internet. Instálalo, descarga un modelo que admita herramientas («ollama pull nombre») y elígelo aquí. En un equipo con 4 GB de memoria irá muy lento: mejor apunta a un equipo más potente de tu red.',
};

const MODEL_HINT = {
  gemini: 'gemini-3.8-flash es rápido y gratuito. Si se acaba el cupo gratuito del día, prueba gemini-3.5-flash-lite.',
  claude: 'claude-haiku-5-5 es el más barato; claude-sonnet-5-5 entiende mejor los pedidos complejos.',
  openai: 'gpt-6-luna es el más barato.',
  openrouter: 'Escribe el id del modelo (empresa/modelo) o pulsa «Ver modelos»: la lista muestra el precio por millón de tokens.',
  ollama: 'Pulsa «Ver modelos» para ver los modelos descargados en Ollama.',
};

const PRIVACY = {
  gemini: 'En el nivel gratuito, Google puede usar lo que envías para mejorar sus productos y personas pueden revisarlo: no lo uses con videos privados ni con datos personales.',
  claude: 'Se aplican las condiciones de uso y privacidad de Anthropic para su API.',
  openai: 'Se aplican las condiciones de uso y privacidad de OpenAI para su API.',
  openrouter: 'OpenRouter reenvía la conversación a la empresa del modelo elegido: se aplican las condiciones de ambas.',
};

export async function openAssistantSettings({ onChange, openMcpDialog } = {}) {
  let cfg = await api.assistant.config();
  let provider = cfg.provider;
  let editingKey = false;
  let keyInput = null;
  let keySlot = null; // la fila de la clave se redibuja sola: el resto (resultado de la prueba…) no se pierde
  let imagesRow = null;
  const changed = () => onChange?.(cfg);
  const body = h('div', { class: 'asst-settings' });
  const sect = h('div', { class: 'asst-set-body' });

  async function saveKey() {
    const v = keyInput?.value.trim();
    if (!v) return false;
    cfg = await api.assistant.setKey(provider, v);
    editingKey = false;
    changed();
    renderKey();
    if (cfg.error) toast(cfg.error, { type: 'error' });
    else toast(cfg.keys[provider]?.session ? 'Clave guardada hasta que cierres LiteCut' : 'Clave guardada', { timeout: 1600 });
    return true;
  }

  function keyRow() {
    const k = cfg.keys[provider] || {};
    keyInput = null;
    if (k.saved && !editingKey) {
      return h(
        'div',
        { class: 'ctl asst-key' },
        h('label', {}, 'Clave de API'),
        h(
          'div',
          { class: 'ctl-in' },
          h('span', { class: 'asst-key-ok' }, h('span', { html: icon('check', 14) }), `Guardada ····${k.hint || ''}${k.session ? ' (hasta cerrar LiteCut)' : ''}`),
          btn('Cambiar', {
            kind: 'small',
            onClick: () => {
              editingKey = true;
              renderKey();
              keyInput?.focus();
            },
          }),
          btn('Borrar', {
            kind: 'small danger',
            onClick: async () => {
              cfg = await api.assistant.setKey(provider, '');
              changed();
              renderKey();
            },
          })
        )
      );
    }
    keyInput = h('input', { type: 'password', class: 'wide-input', placeholder: provider === 'gemini' ? 'Pega aquí tu clave (empieza por AIza…)' : 'Pega aquí tu clave', autocomplete: 'off', spellcheck: 'false' });
    keyInput.addEventListener('keydown', (e) => e.key === 'Enter' && saveKey());
    return h('div', { class: 'ctl asst-key' }, h('label', {}, 'Clave de API'), h('div', { class: 'ctl-in' }, keyInput, btn('Guardar', { kind: 'small primary', onClick: () => saveKey() })));
  }

  const renderKey = () => keySlot?.replaceChildren(keyRow());

  function modelRow() {
    const info = PROVIDER_MAP.get(provider);
    const listId = `asst-models-${provider}`;
    const datalist = h('datalist', { id: listId }, ...info.models.map((m) => h('option', { value: m })));
    const inp = h('input', { type: 'text', class: 'wide-input', value: cfg.models[provider] || '', list: listId, placeholder: info.model || 'Nombre del modelo', spellcheck: 'false' });
    const note = h('p', { class: 'hint' }, MODEL_HINT[provider]);
    const save = async () => {
      cfg = await api.assistant.setConfig({ models: { [provider]: inp.value } });
      changed();
    };
    inp.addEventListener('change', save);
    const more = btn('Ver modelos', {
      kind: 'small',
      icon: 'search',
      title: 'Pedir al proveedor la lista de modelos disponibles para tu clave',
      onClick: async () => {
        if (keyInput?.value.trim()) await saveKey();
        more.disabled = true;
        note.className = 'hint';
        note.textContent = 'Buscando modelos…';
        const r = await api.assistant.models(provider);
        more.disabled = false;
        if (!r.ok) {
          note.className = 'hint asst-err-text';
          note.textContent = r.error;
          return;
        }
        const usable = r.models.filter((m) => m.tools !== false);
        datalist.replaceChildren(...r.models.map((m) => h('option', { value: m.id }, [m.label, m.tools === false ? 'sin herramientas: no sirve' : '', m.images ? 've imágenes' : ''].filter(Boolean).join(' · '))));
        if (!r.models.length) note.textContent = provider === 'ollama' ? 'Ollama no tiene modelos descargados: usa «ollama pull nombre».' : 'El proveedor no devolvió modelos para esta clave.';
        else note.textContent = `${r.models.length} modelos disponibles: haz clic en el campo «Modelo» para elegir.${r.models.length - usable.length ? ` ${r.models.length - usable.length} no admiten herramientas.` : ''}`;
        // Ollama sin modelo elegido: el primero que sepa usar herramientas.
        if (provider === 'ollama' && !inp.value && usable.length) {
          inp.value = usable[0].id;
          await save();
          const pick = usable[0];
          if (pick.images !== undefined && pick.images !== cfg.images.ollama) {
            cfg = await api.assistant.setConfig({ images: { ollama: !!pick.images } });
            imagesRow?.setValue(!!pick.images);
            changed();
          }
        }
      },
    });
    return h('div', {}, h('div', { class: 'ctl' }, h('label', {}, 'Modelo'), h('div', { class: 'ctl-in' }, inp, more)), datalist, note);
  }

  function urlRow(hint) {
    const info = PROVIDER_MAP.get(provider);
    const inp = h('input', { type: 'text', class: 'wide-input', value: cfg.urls[provider] || '', placeholder: info.baseUrl, spellcheck: 'false' });
    inp.addEventListener('change', async () => {
      cfg = await api.assistant.setConfig({ urls: { [provider]: inp.value } });
      if (cfg.error) toast(cfg.error, { type: 'error' });
      changed();
    });
    return h('div', {}, h('div', { class: 'ctl' }, h('label', {}, 'Dirección'), h('div', { class: 'ctl-in' }, inp)), hint ? h('p', { class: 'hint' }, hint) : null);
  }

  function testRow() {
    const out = h('span', { class: 'asst-test-msg' });
    const b = btn('Probar conexión', {
      kind: 'small',
      icon: 'wand',
      onClick: async () => {
        if (keyInput?.value.trim()) await saveKey();
        b.disabled = true;
        out.className = 'asst-test-msg';
        out.textContent = provider === 'ollama' ? 'Probando… (la primera vez Ollama tarda en cargar el modelo)' : 'Probando…';
        const r = await api.assistant.test(provider);
        b.disabled = false;
        out.classList.add(r.ok ? 'ok' : 'err');
        out.textContent = r.ok ? `Funciona: ${r.model} respondió en ${(r.ms / 1000).toFixed(1).replace('.', ',')} s.` : r.error;
      },
    });
    return h('div', { class: 'asst-test' }, b, out);
  }

  function privacyBox() {
    const info = PROVIDER_MAP.get(provider);
    if (info.local) {
      return h('div', { class: 'asst-privacy' }, h('b', {}, 'Tus datos'), h('p', {}, 'Con Ollama la conversación, los datos del proyecto y los fotogramas no salen de tu equipo (o del equipo de tu red cuya dirección indicaste).'));
    }
    return h(
      'div',
      { class: 'asst-privacy' },
      h('b', {}, `Qué se envía a ${info.name}`),
      h(
        'ul',
        {},
        h('li', {}, 'Lo que escribes en el chat y las respuestas de la IA.'),
        h('li', {}, 'Lo que la IA consulta del proyecto: nombres y rutas de tus archivos, duraciones, textos en pantalla y ajustes.'),
        h('li', {}, 'Si la dejas ver fotogramas: imágenes pequeñas (unos 512 px) de los instantes que pide. Los videos nunca se suben.')
      ),
      h('p', {}, PRIVACY[provider]),
      h('p', {}, cfg.encryption ? 'Tu clave se guarda cifrada en este equipo (con el cifrado del sistema) y solo se usa para hablar con el proveedor. LiteCut no tiene servidores propios.' : 'Este equipo no permite cifrar la clave: se recordará solo hasta que cierres LiteCut.')
    );
  }

  function render() {
    const info = PROVIDER_MAP.get(provider);
    const rows = [h('p', { class: 'asst-about' }, ABOUT[provider], ' ', h('a', { href: info.keyUrl, target: '_blank' }, info.local ? 'Descargar Ollama' : 'Crear una clave', h('span', { html: icon('export', 11) })))];
    keySlot = info.needsKey ? h('div') : null;
    keyInput = null;
    if (keySlot) {
      rows.push(keySlot);
      renderKey();
    }
    rows.push(modelRow());
    if (provider === 'ollama') rows.push(urlRow('Por defecto, este mismo equipo. Para otro equipo de tu red: http://IP-del-equipo:11434'));
    imagesRow = toggleRow({
      label: 'Dejar que la IA vea fotogramas del video (imágenes pequeñas)',
      value: cfg.images[provider],
      hint: 'Necesario para que revise cómo quedan los textos y el encuadre. Desactívalo si el modelo no entiende imágenes.',
      onChange: async (v) => {
        cfg = await api.assistant.setConfig({ images: { [provider]: v } });
        changed();
      },
    });
    rows.push(imagesRow);
    if (provider === 'openai') rows.push(h('details', { class: 'asst-adv' }, h('summary', {}, 'Avanzado'), urlRow('Otra dirección compatible con la API de OpenAI (LM Studio, Groq, DeepSeek…). Déjala vacía para usar OpenAI.')));
    rows.push(testRow(), privacyBox());
    sect.replaceChildren(...rows);
  }

  body.append(
    h('p', { class: 'dialog-text' }, 'Elige con qué IA chatear. Usas tu propia cuenta: LiteCut no cobra nada y no guarda tus conversaciones.'),
    segmented({
      options: ASSISTANT_PROVIDERS.map((p) => ({ value: p.id, label: p.label })),
      value: provider,
      onChange: async (v) => {
        provider = v;
        editingKey = false;
        cfg = await api.assistant.setConfig({ provider: v });
        changed();
        render();
      },
    }),
    sect,
    openMcpDialog
      ? h(
          'p',
          { class: 'hint' },
          '¿Prefieres Claude Desktop, Gemini CLI u otra app de IA de tu equipo? ',
          h('a', { href: '#', onclick: (e) => (e.preventDefault(), dlg.close(), openMcpDialog()) }, 'Conéctala con LiteCut')
        )
      : null
  );
  render();
  const dlg = modal({ title: 'Ajustes del asistente', body, width: 660, className: 'asst-modal', buttons: [{ label: 'Listo', kind: 'primary' }], onClose: () => changed() });
  setTimeout(() => keyInput?.focus(), 60);
  return dlg;
}
