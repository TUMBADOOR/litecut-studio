// Proveedores de IA del asistente integrado: datos comunes a la interfaz (ventana de ajustes) y al proceso
// principal (llamadas HTTP). Los modelos por defecto son los más baratos que entienden herramientas e imágenes;
// el usuario puede escribir otro o pedir la lista de modelos disponibles para su clave.
export const ASSISTANT_PROVIDERS = [
  {
    id: 'gemini',
    name: 'Google Gemini',
    label: 'Gemini (gratis)',
    needsKey: true,
    keyUrl: 'https://aistudio.google.com/apikey',
    model: 'gemini-3.8-flash',
    models: ['gemini-3.8-flash', 'gemini-3.5-flash-lite', 'gemini-3.6-flash'],
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    images: true,
  },
  {
    id: 'claude',
    name: 'Anthropic Claude',
    label: 'Claude',
    needsKey: true,
    keyUrl: 'https://platform.claude.com/settings/keys',
    model: 'claude-haiku-5-5',
    models: ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'],
    baseUrl: 'https://api.anthropic.com/v1',
    images: true,
  },
  {
    id: 'openai',
    name: 'OpenAI',
    label: 'OpenAI',
    needsKey: true,
    keyUrl: 'https://platform.openai.com/api-keys',
    model: 'gpt-6-luna',
    models: ['gpt-6-luna', 'gpt-6.1-sol'],
    baseUrl: 'https://api.openai.com/v1',
    images: true,
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    label: 'OpenRouter',
    needsKey: true,
    keyUrl: 'https://openrouter.ai/keys',
    model: 'google/gemini-3.8-flash',
    models: ['google/gemini-3.8-flash'],
    baseUrl: 'https://openrouter.ai/api/v1',
    images: true,
  },
  {
    id: 'ollama',
    name: 'Ollama (en este equipo o en tu red)',
    label: 'Ollama (local)',
    needsKey: false,
    keyUrl: 'https://ollama.com/download',
    model: '',
    models: [],
    baseUrl: 'http://localhost:11434',
    images: false,
    local: true,
  },
];

export const PROVIDER_MAP = new Map(ASSISTANT_PROVIDERS.map((p) => [p.id, p]));

// Herramientas que solo sirven si el modelo recibe imágenes.
export const IMAGE_TOOLS = ['ver_fotograma', 'fotogramas_de_muestra'];
