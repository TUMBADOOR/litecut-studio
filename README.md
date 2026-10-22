# LiteCut Studio

Editor de video **liviano** con **grabador de pantalla**, al estilo de Filmora / CapCut, para **Windows** y **macOS**.
Interfaz en español, pensado para funcionar bien incluso en equipos modestos (probado en un Intel Celeron N4120 con 4 GB de RAM).

## Funciones

**Edición**
- Línea de tiempo con varias pistas de video/texto y de audio, pista principal "magnética" (insertar desplaza los clips siguientes).
- Arrastrar y soltar desde la biblioteca o desde el Explorador/Finder, imán (ajuste a bordes y al cursor), zoom, selección múltiple con recuadro.
- Dividir (S), recortar arrastrando los bordes, duplicar, copiar/pegar, eliminar y cerrar hueco, deshacer/rehacer ilimitado.
- Separar el audio de un video (queda vinculado y sigue al video), congelar fotograma, cambiar velocidad (0,1× a 8×, conserva el tono).
- Mover, escalar y rotar directamente sobre el visor, con guías de centrado. Recorte, máscara circular/redondeada, voltear, opacidad.
- 13 transiciones (disolver, fundido, deslizar, empujar, barrido, círculo, zoom…), animaciones de entrada y salida, efecto Ken Burns.
- 16 filtros de color y ajustes manuales (brillo, contraste, saturación, tono, temperatura, matiz, sepia, B/N, desenfoque, viñeta).
- Textos con 12 fuentes incluidas + fuentes del sistema, contorno, sombra, fondo, 14 estilos rápidos y stickers (emojis).
- Lienzo 16:9, 9:16 (TikTok/Reels), 1:1, 4:5, 4:3, 21:9 o tamaño personalizado, con **fondo desenfocado**
  para pasar videos horizontales a vertical sin barras negras.
- Voz en off: graba tu micrófono mientras se reproduce el video.
- Proyectos `.lcproj`, recientes y autoguardado con recuperación.

**Efectos y herramientas** (pestaña «Efectos» y clic derecho sobre un clip)
- Efectos para «edits»: **temblor**, **impacto** (sacudida que se calma), **golpe de zoom**, **pulso al ritmo** y
  **destello** blanco, con intensidad ajustable (Animación). Se exportan igual que se ven.
- **Marcadores** (M o la bandera de la barra) y **detección de ritmo**: pone marcadores en los golpes de la música y el
  imán se pega a ellos para cortar al ritmo. El «pulso al ritmo» sigue esos marcadores.
- **Quitar silencios** de un clip con voz, **dividir por escenas** (un corte en cada cambio de plano),
  **normalizar volumen** (−14 LUFS, como YouTube o TikTok) e **invertir** un clip (hacia atrás).

**Grabador de pantalla**
- Pantalla completa, una ventana o un área personalizada.
- Micrófono (con medidor de nivel), audio del sistema y cámara web (en una pista aparte, en círculo, que puedes mover).
- Cuenta regresiva, pausa/reanudar, barra flotante que **no aparece en la grabación**, atajos globales.
- Al terminar: se añade al proyecto (el lienzo se adapta al tamaño grabado) o solo se guarda en `Videos/LiteCut Studio`.

**Exportación** (con FFmpeg)
- MP4 H.264, MP4 H.265, WebM, GIF, MP3 y WAV. Resolución de 360p a 4K, 24–60 fps, tres niveles de calidad.
- Usa la tarjeta gráfica si existe (Intel Quick Sync, NVIDIA NVENC, AMD AMF, Apple VideoToolbox) y, si falla, la CPU.
- Lo que ves en la vista previa es lo que se exporta: textos, filtros, máscaras, transiciones y animaciones usan la misma matemática en ambos.

**Rendimiento en equipos modestos**
- Detecta el procesador, la memoria y qué formatos decodifica la gráfica (menú de calidad del visor › «Rendimiento de este equipo…»).
- Los videos que el equipo no mueve con soltura (por ejemplo AV1, o 1440p/4K en portátiles modestos) se editan con
  **copias ligeras** de 720p creadas en segundo plano **solo de las partes que usa el proyecto** (segundos en vez de
  minutos; si añades otra parte, se convierte en cuanto la usas). La exportación usa siempre el archivo original.
- Mientras la ventana está activa, la app tiene prioridad sobre otros programas; miniaturas, ondas de audio y copias ligeras
  se crean con prioridad baja para no trabar nada.
- Si un video tarda en cargar, la reproducción espera un instante (aviso «Cargando…») en vez de saltar y cortar el audio.

**Conectar con tu IA** (Gemini, Claude, OpenAI, OpenRouter, Ollama y apps compatibles con MCP)
- Pídele a la IA, con tu propia cuenta, cosas como «importa este video, corta los silencios, pon un título y
  expórtalo en 9:16». Los cambios se ven al instante en LiteCut y cada uno se deshace con Ctrl+Z.
- **Asistente integrado**: un chat dentro de LiteCut (pestaña «Asistente») con tu propia clave; con Google Gemini es
  gratis. No hace falta instalar nada más.
- O conecta tu app de IA de escritorio (Claude Desktop, Gemini CLI, Cursor…) por MCP.
- La IA puede **ver** el proyecto (fotogramas pequeños) y **analizar** los videos sin reproducirlos: silencios,
  cambios de escena y fotogramas de muestra, con FFmpeg y a baja prioridad para no cargar el equipo.
- También usa las herramientas de edición: detectar el ritmo para cortar al compás, aplicar efectos, invertir clips,
  normalizar el volumen y dividir por escenas.

## Conectar con tu IA

Hay dos formas, con las mismas herramientas de edición: el **Asistente integrado** (un chat dentro de LiteCut, para
quien no tiene una app de IA en el equipo) o tu **app de IA de escritorio** conectada por MCP.

### Asistente integrado (chat dentro de LiteCut)

1. Consigue una clave de API. La más fácil es la de **Google Gemini, que es gratis**: entra con tu cuenta de Google en
   [Google AI Studio](https://aistudio.google.com/apikey) y pulsa «Crear clave de API» (no pide tarjeta).
2. En LiteCut abre la pestaña **Asistente** (barra lateral izquierda) y pulsa **Configurar el asistente** (o el
   engranaje ⚙). Elige el proveedor, pega la clave, pulsa **Guardar** y después **Probar conexión**.
3. Escribe lo que quieres, por ejemplo «corta los silencios y pon el título «Clase 1»», y pulsa Enter.

En el chat se ve cada herramienta que usa la IA (con su título en español, el resultado y las imágenes que mira).
**Detener** la para en cualquier momento; cada cambio se deshace con **Ctrl+Z** y, al terminar, el botón
**Deshacer** quita de una vez todo lo que hizo en ese pedido. La IA puede usar hasta 30 pasos por pedido (escribe
«sigue» para que continúe). Si el proveedor pide esperar (por ejemplo, el límite por minuto del nivel gratuito de
Gemini), LiteCut espera y reintenta solo, con la cuenta atrás a la vista.

| Proveedor | Modelo por defecto | Clave | Notas |
|---|---|---|---|
| Google Gemini | `gemini-3.8-flash` | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) | Nivel gratuito con límite por minuto y por día; `gemini-3.5-flash-lite` tiene más cupo. |
| Anthropic Claude | `claude-haiku-5-5` | [platform.claude.com](https://platform.claude.com/settings/keys) | Pago por uso; `claude-sonnet-5-5` para pedidos complejos. |
| OpenAI | `gpt-6-luna` | [platform.openai.com](https://platform.openai.com/api-keys) | Pago por uso. En «Avanzado» admite otra dirección compatible (LM Studio, Groq…). |
| OpenRouter | `google/gemini-3.8-flash` | [openrouter.ai/keys](https://openrouter.ai/keys) | Cientos de modelos con una sola clave; «Ver modelos» muestra los precios. |
| Ollama (local) | el que tengas descargado | no necesita | Todo queda en tu equipo o en tu red. En un equipo de 4 GB va muy lento: mejor apunta a otro más potente. |

«Ver modelos» pide al proveedor la lista de modelos disponibles para tu clave (en Ollama, los descargados y si
admiten herramientas e imágenes).

**Qué se envía y dónde queda la clave**: al proveedor elegido le llegan lo que escribes, lo que la IA consulta del
proyecto (nombres y rutas de archivos, tiempos, textos en pantalla, ajustes) y, si lo permites, fotogramas pequeños
(unos 512 px). Los videos nunca se suben. LiteCut habla directamente con el proveedor, sin servidores propios. En el
nivel gratuito de Gemini, Google puede usar esos datos para mejorar sus productos: no lo uses con videos privados.
La clave se guarda **cifrada con el sistema operativo** (Electron `safeStorage`: DPAPI en Windows, Llavero en macOS)
en `asistente-claves.json` dentro de la carpeta de datos de LiteCut, y la interfaz nunca la vuelve a leer: las
llamadas HTTP salen del proceso principal (con la red de Chromium, que respeta el proxy del sistema). Si el sistema
no permite cifrar, la clave se recuerda solo hasta cerrar LiteCut. La conversación no se guarda en disco.

**Si algo falla**: «rechazó la clave» → vuelve a pegarla en Ajustes. «Se agotó el cupo diario gratuito» → espera a
mañana o elige otro modelo. «No encontró el modelo» → pulsa «Ver modelos». «No se pudo conectar con Ollama» →
comprueba que Ollama está abierto (y, si está en otro equipo, que acepte conexiones de la red).

### Tu app de IA de escritorio (MCP)

LiteCut incluye un **servidor MCP local** (el estándar que usan Claude Desktop, Gemini CLI, Cursor, VS Code, LM Studio…).
Tu app de IA lanza un pequeño puente (`litecut-mcp`) que habla con LiteCut abierto. Todo ocurre en tu equipo: LiteCut
escucha solo en `127.0.0.1` con una clave aleatoria que cambia en cada inicio; nada queda abierto a internet ni a tu red.
Tu app de IA sí envía a su proveedor (Anthropic, Google…) los datos del proyecto y los fotogramas que pide, como con
cualquier otra conversación de tu cuenta.

1. En LiteCut pulsa **IA** (barra superior) y activa **«Permitir que las apps de IA de este equipo usen LiteCut»**.
2. Elige tu app:
   - **Claude Desktop** (sirve el plan gratuito): pulsa **Configurar Claude Desktop**, o copia el bloque que muestra
     la ventana en Configuración › Desarrollador › Editar configuración. Cierra Claude por completo y vuelve a abrirlo.
   - **Gemini CLI** (`npm install -g @google/gemini-cli`, nivel gratuito con tu cuenta de Google): pulsa
     **Configurar Gemini CLI** o pega el bloque en `~/.gemini/settings.json`. Comprueba con `/mcp` que aparece «litecut».
   - **Otras apps**: la pestaña «Otras apps» da la configuración `mcpServers` estándar, el comando y la orden para Claude Code.
3. Pide lo que quieras. Si LiteCut está cerrado, se abre solo al usar la primera herramienta.

La configuración usa el propio ejecutable de LiteCut como intérprete (`ELECTRON_RUN_AS_NODE=1`), así que no hace falta
instalar Node.js. Con la **versión portable** no funciona (cambia de carpeta en cada arranque): usa el instalador.

**Herramientas que recibe la IA**: `ver_proyecto`, `ver_clip`, `importar_medios`, `agregar_clip`, `dividir`,
`recortar_clip`, `mover_clip`, `eliminar_clips`, `eliminar_tramo`, `cambiar_velocidad`, `ajustar_clip`, `agregar_texto`,
`editar_texto`, `poner_transicion`, `quitar_transicion`, `aplicar_filtro`, `configurar_proyecto`, `ver_fotograma`,
`exportar` (con progreso), `estado_exportacion`, `deshacer`, `rehacer`, `detectar_silencios`, `cortar_silencios`,
`detectar_escenas`, `fotogramas_de_muestra` y `guardar_proyecto`. Exportar nunca sobrescribe un archivo salvo que se pida.

**Si algo falla**: «la conexión con IA está desactivada» → actívala en LiteCut › IA. «No se pudo conectar» → cierra y
vuelve a abrir LiteCut y tu app de IA. Si cambias LiteCut de carpeta, vuelve a pulsar «Configurar…».

## Usar la app en Windows

En la carpeta `dist` está:
- `LiteCut-Studio-Setup-1.0.0.exe`: instalador (no pide permisos de administrador).
- `LiteCut-Studio-Portable-1.0.0.exe`: versión portable, no necesita instalación.

Windows SmartScreen puede avisar porque la app no está firmada: pulsa **Más información › Ejecutar de todas formas**.

## Versión para macOS

La versión de Mac se compila desde el mismo código. Hay dos formas:

**A) En una Mac** (con [Node.js 22+](https://nodejs.org) instalado):
```bash
bash construir-mac.sh          # para la arquitectura de esa Mac
bash construir-mac.sh arm64    # Mac con chip Apple (M1, M2, M3, M4)
bash construir-mac.sh x64      # Mac con procesador Intel
```
Se generan `dist/LiteCut-Studio-1.0.0-mac-<arquitectura>.dmg` y `.zip`.

**B) Sin Mac, con GitHub** (gratis): este proyecto ya incluye el flujo `.github/workflows/build.yml`.
Al subir una etiqueta de versión, GitHub compila Windows, Mac Apple Silicon y Mac Intel y publica
una página de descarga en **Releases** con los instaladores:
```bash
git tag v1.0.1
git push origin v1.0.1
```
(La versión del archivo `package.json` es la que aparece en el nombre de los instaladores.)
También puedes lanzarlo a mano en **Actions › Compilar instaladores › Run workflow**; en ese caso los
instaladores quedan como archivos ZIP al final de la página de esa ejecución.

**Primera apertura en Mac:** como la app no está notarizada por Apple, haz clic derecho sobre LiteCut Studio ›
**Abrir** › **Abrir**. Si dice "está dañada", ejecuta en Terminal: `xattr -cr "/Applications/LiteCut Studio.app"`.

**Permisos en Mac:** la primera vez que grabes, macOS pedirá permiso de **Grabación de pantalla**, **Micrófono**
y **Cámara** (Ajustes del Sistema › Privacidad y seguridad). Después de activar la grabación de pantalla hay que
reabrir la app. El audio del sistema en Mac depende de la versión de macOS; si no está disponible, la app graba
sin él y lo avisa (puedes usar el controlador gratuito BlackHole como alternativa).

## Desarrollo

Requisitos: Node.js 22 o superior (en este equipo hay una copia portable en `tools/node`).

```bash
npm install        # dependencias
npm start          # abrir la app sin instalar (en Windows: iniciar.bat)
npm test           # pruebas de edición, de la conexión con IA, del asistente integrado y de exportación con FFmpeg
npm run test:mcp   # prueba de punta a punta: abre LiteCut en modo de prueba y lo maneja como un cliente MCP
npm run test:assistant  # prueba de punta a punta del Asistente con un proveedor simulado (imita la API de OpenAI)
npm run dist:win   # instalador de Windows (o construir-windows.bat)
npm run dist:mac   # versión de Mac (en una Mac)
```

En desarrollo, el puente MCP se puede lanzar con Node: `node src/mcp/litecut-mcp.cjs` (opciones `--dir <carpeta de datos>`
y `--no-launch`). Las herramientas se describen en `src/shared/ai-tools.js` y se implementan en
`src/renderer/js/ai-commands.js`; desde la consola de desarrollo se pueden probar con `await __app.ai('ver_proyecto', {})`.

El asistente integrado usa esas mismas herramientas. El bucle del agente está en `src/renderer/js/assistant.js` (envía la
conversación, ejecuta las herramientas en la misma cola que MCP y devuelve los resultados); las llamadas HTTP, la clave
y la configuración, en `src/main/assistant.js`; y la traducción de herramientas, mensajes, imágenes y errores para cada
proveedor, en `src/main/assistant-providers.js` (sin Electron: lo prueba `scripts/test-assistant.js`). Los proveedores
y sus modelos por defecto están en `src/shared/assistant-catalog.js`.

### Estructura
```
src/main/        Proceso principal de Electron: ventanas, menú, FFmpeg, exportación, grabador,
                 servidor MCP local para asistentes de IA (ai.js, ai-server.js) y asistente integrado
                 (assistant.js, assistant-providers.js)
src/mcp/         Puente «litecut-mcp» por stdio que lanzan las apps de IA
src/renderer/    Interfaz: editor (index.html), barra de grabación y selector de región
src/shared/      Código común a vista previa y exportación: modelo, efectos, geometría,
                 operaciones de edición, generador del grafo de FFmpeg y herramientas para IA
scripts/         Pruebas, ícono y copia de fuentes
build/           Ícono y permisos de macOS para el instalador
```

## Atajos de teclado

| Atajo | Acción |
|---|---|
| Espacio | Reproducir / pausar |
| S | Dividir en el cursor |
| Supr / Mayús+Supr | Eliminar / eliminar y cerrar hueco |
| Ctrl+Z / Ctrl+Y | Deshacer / rehacer (⌘ en Mac) |
| Ctrl+C / V / D | Copiar / pegar / duplicar |
| ← → / Mayús+← → | Fotograma anterior/siguiente / ±1 segundo |
| ↑ ↓ | Corte anterior / siguiente |
| Alt+← → | Mover clips seleccionados |
| + / − / Mayús+Z | Zoom de la línea de tiempo / ajustar |
| T | Añadir texto |
| M | Añadir / quitar marcador en el cursor |
| Ctrl+E | Exportar |
| Ctrl+Mayús+R | Grabar pantalla |
| Ctrl+Alt+S / Ctrl+Alt+P | Detener / pausar la grabación |

## Licencias

- Código de LiteCut Studio: MIT.
- Incluye [FFmpeg](https://ffmpeg.org) (compilación con licencia GPL) a través de `ffmpeg-static`. Si distribuyes la app,
  debes respetar la licencia GPL de FFmpeg (indicar la licencia y ofrecer su código fuente).
- Fuentes tipográficas con licencia SIL Open Font License (ver `src/renderer/fonts/LICENSE-*.txt`).
