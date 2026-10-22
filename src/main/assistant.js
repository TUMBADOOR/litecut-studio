// Asistente integrado (proceso principal): guarda la configuración y la clave del proveedor de IA (cifrada con el
// sistema operativo, en la carpeta de datos) y hace las llamadas HTTP. La interfaz nunca recibe la clave: envía la
// conversación y recibe la respuesta ya traducida (ver assistant-providers.js). Los adaptadores se cargan la primera
// vez que se usan.
import { ipcMain, safeStorage, net } from 'electron';
import { ASSISTANT_PROVIDERS, PROVIDER_MAP } from '../shared/assistant-catalog.js';

const CONFIG_FILE = 'asistente.json';
const KEYS_FILE = 'asistente-claves.json';

export function setupAssistant({ storage, getWindow }) {
  let mod = null;
  const providers = async () => (mod ||= await import('./assistant-providers.js'));
  const sessionKeys = new Map(); // si el sistema no deja cifrar, la clave solo vive mientras LiteCut está abierto
  const inflight = new Map();
  // La red de Electron (Chromium) respeta el proxy y los certificados del sistema, a diferencia del fetch de Node.
  const fetchImpl = (url, init) => net.fetch(url, init);

  const send = (channel, payload) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  };
  const fail = (err) => ({ ok: false, error: err?.message || String(err), code: err?.code || 'request', details: err?.details || '' });

  // ---------- Configuración ----------
  function readConfig() {
    const s = storage.readJson(CONFIG_FILE, {}) || {};
    const c = { provider: PROVIDER_MAP.has(s.provider) ? s.provider : 'gemini', models: {}, urls: {}, images: {} };
    for (const p of ASSISTANT_PROVIDERS) {
      c.models[p.id] = typeof s.models?.[p.id] === 'string' ? s.models[p.id] : p.model;
      c.urls[p.id] = typeof s.urls?.[p.id] === 'string' ? s.urls[p.id] : '';
      c.images[p.id] = typeof s.images?.[p.id] === 'boolean' ? s.images[p.id] : p.images;
    }
    return c;
  }

  // ---------- Claves ----------
  const canEncrypt = () => {
    try {
      return safeStorage.isEncryptionAvailable();
    } catch {
      return false;
    }
  };
  const hintOf = (key) => key.slice(-4);

  function keyOf(provider) {
    if (sessionKeys.has(provider)) return sessionKeys.get(provider);
    const k = storage.readJson(KEYS_FILE, {})?.[provider];
    if (!k?.data) return '';
    try {
      return safeStorage.decryptString(Buffer.from(k.data, 'base64'));
    } catch {
      return ''; // cifrada con otra cuenta de usuario o en otro equipo: hay que volver a pegarla
    }
  }

  function keyInfo() {
    const saved = storage.readJson(KEYS_FILE, {}) || {};
    return Object.fromEntries(
      ASSISTANT_PROVIDERS.map((p) => {
        if (sessionKeys.has(p.id)) return [p.id, { saved: true, hint: hintOf(sessionKeys.get(p.id)), session: true }];
        return [p.id, saved[p.id]?.data ? { saved: true, hint: saved[p.id].hint || '' } : { saved: false }];
      })
    );
  }

  function setKey(provider, key) {
    const keys = storage.readJson(KEYS_FILE, {}) || {};
    sessionKeys.delete(provider);
    delete keys[provider];
    const clean = String(key || '').replace(/^\s*Bearer\s+/i, '').replace(/\s+/g, '');
    if (clean && canEncrypt()) keys[provider] = { data: safeStorage.encryptString(clean).toString('base64'), hint: hintOf(clean) };
    else if (clean) sessionKeys.set(provider, clean);
    storage.writeJson(KEYS_FILE, keys);
  }

  const publicConfig = (extra = {}) => ({ ...readConfig(), keys: keyInfo(), encryption: canEncrypt(), ...extra });

  function current(provider) {
    const c = readConfig();
    const id = PROVIDER_MAP.has(provider) ? provider : c.provider;
    return { provider: id, model: c.models[id], baseUrl: c.urls[id], images: c.images[id], key: keyOf(id) };
  }

  // ---------- IPC ----------
  ipcMain.handle('assistant:config', () => publicConfig());
  ipcMain.handle('assistant:setConfig', (_e, patch = {}) => {
    const c = readConfig();
    let error = null;
    if (PROVIDER_MAP.has(patch.provider)) c.provider = patch.provider;
    for (const [id, v] of Object.entries(patch.models || {})) if (PROVIDER_MAP.has(id) && typeof v === 'string') c.models[id] = v.trim().slice(0, 200);
    for (const [id, v] of Object.entries(patch.urls || {})) {
      if (!PROVIDER_MAP.has(id) || typeof v !== 'string') continue;
      const u = v.trim();
      if (u && !/^https?:\/\/\S+$/i.test(u)) error = 'La dirección debe empezar por http:// o https://';
      else c.urls[id] = u;
    }
    for (const [id, v] of Object.entries(patch.images || {})) if (PROVIDER_MAP.has(id)) c.images[id] = !!v;
    storage.writeJson(CONFIG_FILE, c);
    return publicConfig(error ? { error } : {});
  });
  ipcMain.handle('assistant:setKey', (_e, provider, key) => {
    if (!PROVIDER_MAP.has(provider)) return publicConfig({ error: 'Proveedor desconocido' });
    try {
      setKey(provider, key);
      return publicConfig();
    } catch (err) {
      return publicConfig({ error: `No se pudo guardar la clave: ${err.message}` });
    }
  });

  // Un paso de la conversación (la interfaz ejecuta las herramientas y vuelve a llamar con los resultados).
  ipcMain.handle('assistant:chat', async (_e, { id, messages }) => {
    const p = await providers();
    const o = current();
    const ac = new AbortController();
    inflight.set(id, ac);
    try {
      const value = await p.chat({
        ...o,
        system: p.assistantSystem({ images: o.images }),
        tools: p.assistantTools({ images: o.images }),
        messages,
        signal: ac.signal,
        fetch: fetchImpl,
        onWait: (w) => send('assistant:wait', { id, ...w }),
      });
      return { ok: true, value: { ...value, provider: o.provider, model: o.model } };
    } catch (err) {
      return fail(err);
    } finally {
      inflight.delete(id);
    }
  });
  ipcMain.handle('assistant:cancel', (_e, id) => {
    inflight.get(id)?.abort();
    return true;
  });

  // Probar conexión: una pregunta mínima con la lista de herramientas (así se nota si el modelo no las admite).
  ipcMain.handle('assistant:test', async (_e, provider) => {
    const p = await providers();
    const o = current(provider);
    const t0 = Date.now();
    try {
      const v = await p.chat({
        ...o,
        system: 'Responde en español, en una palabra.',
        tools: p.assistantTools({ images: o.images }),
        messages: [{ role: 'user', text: 'Prueba de conexión desde LiteCut Studio: responde solo «OK», sin usar herramientas.' }],
        maxTokens: 512,
        fetch: fetchImpl,
        timeout: o.provider === 'ollama' ? 300000 : 60000,
      });
      return { ok: true, ms: Date.now() - t0, text: v.text.slice(0, 200), provider: o.provider, model: o.model };
    } catch (err) {
      return fail(err);
    }
  });
  ipcMain.handle('assistant:models', async (_e, provider) => {
    const p = await providers();
    try {
      return { ok: true, models: await p.listModels({ ...current(provider), fetch: fetchImpl }) };
    } catch (err) {
      return fail(err);
    }
  });

  return {
    onWindow(win) {
      // Si la interfaz se recarga o se cierra, las peticiones en curso ya no tienen quién las espere.
      const abortAll = () => {
        for (const ac of inflight.values()) ac.abort();
        inflight.clear();
      };
      win.webContents.on('did-start-loading', abortAll);
      win.on('closed', abortAll);
    },
  };
}
