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
- Los videos que el equipo no mueve con soltura (por ejemplo AV1, o 1440p/4K en portátiles modestos) se editan con una
  **copia ligera** de 720p creada en segundo plano. La exportación usa siempre el archivo original.
- Mientras la ventana está activa, la app tiene prioridad sobre otros programas; miniaturas, ondas de audio y copias ligeras
  se crean con prioridad baja para no trabar nada.
- Si un video tarda en cargar, la reproducción espera un instante (aviso «Cargando…») en vez de saltar y cortar el audio.

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
npm test           # pruebas de edición y de exportación con FFmpeg
npm run dist:win   # instalador de Windows (o construir-windows.bat)
npm run dist:mac   # versión de Mac (en una Mac)
```

### Estructura
```
src/main/        Proceso principal de Electron: ventanas, menú, FFmpeg, exportación, grabador
src/renderer/    Interfaz: editor (index.html), barra de grabación y selector de región
src/shared/      Código común a vista previa y exportación: modelo, efectos, geometría,
                 operaciones de edición y generador del grafo de FFmpeg
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
| Ctrl+E | Exportar |
| Ctrl+Mayús+R | Grabar pantalla |
| Ctrl+Alt+S / Ctrl+Alt+P | Detener / pausar la grabación |

## Licencias

- Código de LiteCut Studio: MIT.
- Incluye [FFmpeg](https://ffmpeg.org) (compilación con licencia GPL) a través de `ffmpeg-static`. Si distribuyes la app,
  debes respetar la licencia GPL de FFmpeg (indicar la licencia y ofrecer su código fuente).
- Fuentes tipográficas con licencia SIL Open Font License (ver `src/renderer/fonts/LICENSE-*.txt`).
