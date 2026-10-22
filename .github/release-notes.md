## Novedades en 1.1.0: efectos, ritmo e IA

**Efectos y herramientas** (nueva pestaña «Efectos» y clic derecho sobre un clip)
- Efectos para «edits»: **temblor**, **impacto**, **golpe de zoom**, **pulso al ritmo** y **destello**, con intensidad
  ajustable en Animación. Se exportan exactamente como se ven.
- **Marcadores** (tecla **M** o la bandera de la barra) y **detección de ritmo**: pone marcadores en los golpes de la música
  y el imán se pega a ellos para cortar al compás.
- **Quitar silencios** de un clip con voz, **dividir por escenas**, **normalizar volumen** (−14 LUFS, como YouTube o
  TikTok) e **invertir** un clip para que vaya hacia atrás. Todo se deshace con Ctrl+Z.

**Inteligencia artificial**
- **Asistente integrado** (pestaña «Asistente»): pídele cambios en un chat con tu propia clave; con Google Gemini es gratis.
- **Conexión por MCP** para Claude Desktop, Gemini CLI, Cursor y otras apps de IA (menú «IA» arriba a la derecha).
- La IA puede ver el proyecto, analizar silencios y escenas, detectar el ritmo, aplicar efectos, invertir y normalizar.

**Más rápida en equipos modestos**
- Las copias ligeras de los videos pesados (AV1, 1440p/4K) se hacen **solo de las partes que usa el proyecto**: un video
  AV1 1440p queda listo en menos de un minuto en vez de cinco.
- Incluye las mejoras de la 1.0.1: la vista previa no salta ni corta el audio, LiteCut tiene prioridad sobre otros
  programas y en el visor está «Rendimiento de este equipo…».
- La barra lateral cabe entera en pantallas de 768 px.

## Descargas

| Sistema | Archivo |
|---|---|
| **Windows** (instalador) | `LiteCut-Studio-Setup-…exe` |
| **Windows** (portable, sin instalar) | `LiteCut-Studio-Portable-…exe` |
| **Mac con chip Apple** (M1, M2, M3, M4) | `LiteCut-Studio-…-mac-arm64.dmg` |
| **Mac con procesador Intel** | `LiteCut-Studio-…-mac-x64.dmg` |

Los archivos están más abajo, en **Assets**.

### Primera vez que la abres

- **Windows:** si aparece «Windows protegió su PC», pulsa **Más información › Ejecutar de todas formas** (la app no está firmada con certificado de pago).
- **Mac:** abre el `.dmg` y arrastra **LiteCut Studio** a **Aplicaciones**. La primera vez haz **clic derecho › Abrir › Abrir**.
  Si macOS dice que la app «está dañada», abre Terminal y ejecuta:
  `xattr -cr "/Applications/LiteCut Studio.app"`
- Para grabar la pantalla en Mac, activa LiteCut Studio en **Ajustes del Sistema › Privacidad y seguridad › Grabación de pantalla** y vuelve a abrir la app.
