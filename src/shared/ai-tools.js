// Herramientas que LiteCut ofrece a los asistentes de IA (servidor MCP y asistente integrado).
// Aquí solo está la descripción de cada una (nombre, texto para la IA y JSON Schema de sus parámetros); la
// implementación vive en renderer/js/ai-commands.js. Los esquemas usan un subconjunto sencillo de JSON Schema
// (sin oneOf ni additionalProperties) que entienden Claude, Gemini, OpenAI y los modelos locales.
import { ASPECTS } from './model.js';
import { TRANSITIONS, FILTER_PRESETS, ANIMS_IN, ANIMS_OUT, KENBURNS, MASKS, EFFECTS } from './effects.js';
import { TEXT_PRESETS, FONTS } from './text-presets.js';

export const AI_SERVER_NAME = 'litecut-studio';

export const AI_INSTRUCTIONS = [
  'LiteCut Studio es un editor de video abierto en el equipo del usuario. Cada cambio se ve al instante en la app',
  'y se puede deshacer (herramienta deshacer o Ctrl+Z).',
  'Los tiempos son segundos de la línea de tiempo (se admiten decimales). Empieza con ver_proyecto para conocer los ids.',
  'La pista V1 es la principal: sus clips van seguidos y al insertar, cortar o recortar se desplazan los siguientes.',
  'Los textos y las superposiciones van en pistas superiores (V2, V3…) y el audio en A1, A2…',
  'Para revisar el resultado usa ver_fotograma. Para entender un video sin reproducirlo usa fotogramas_de_muestra,',
  'detectar_silencios y detectar_escenas. El equipo del usuario puede ser modesto: exportar puede tardar; si exportar',
  'responde que sigue en curso, consulta estado_exportacion. No sobrescribas archivos salvo que el usuario lo pida.',
  'Para editar al ritmo de una canción usa detectar_ritmo (devuelve los pulsos) y corta o coloca los clips en esos instantes;',
  'para efectos de «edit» (temblor, impacto, golpe de zoom, pulso, destello) usa aplicar_efecto.',
].join(' ');

// ---------- Piezas de los esquemas ----------
const num = (description, extra = {}) => ({ type: 'number', description, ...extra });
const int = (description, extra = {}) => ({ type: 'integer', description, ...extra });
const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
const bool = (description) => ({ type: 'boolean', description });
const list = (description, items = { type: 'string' }) => ({ type: 'array', items, description });
const obj = (properties, required = []) => ({ type: 'object', properties, required });
const list2 = (items) => items.map((x) => `${x.id} (${x.name})`).join(', ');

const T = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const EDIT = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

const CLIP = str('Id del clip (lo da ver_proyecto).');
const MEDIA = str('Id de un medio importado (lo da ver_proyecto o importar_medios).');
const TRACK = str('Pista: «V1» (principal), «V2», «A1»…, su id, o «nueva» para crear una.');
const ANIM_IN = str(`Animación de entrada: ${list2(ANIMS_IN)}.`, { enum: ANIMS_IN.map((a) => a.id) });
const ANIM_OUT = str(`Animación de salida: ${list2(ANIMS_OUT)}.`, { enum: ANIMS_OUT.map((a) => a.id) });

const TEXT_STYLE = {
  texto: str('Contenido del texto. Usa \\n para varias líneas.'),
  estilo: str(`Estilo rápido: ${list2(TEXT_PRESETS)}.`, { enum: TEXT_PRESETS.map((p) => p.id) }),
  posicion: str('Posición vertical rápida.', { enum: ['arriba', 'centro', 'abajo'] }),
  x: num('Posición horizontal del centro, en píxeles desde el centro del lienzo (negativo = izquierda).'),
  y: num('Posición vertical del centro, en píxeles desde el centro del lienzo (negativo = arriba).'),
  tamano: num('Tamaño de letra en píxeles del lienzo. Si no se indica, el texto se ajusta para caber en el ancho.', { minimum: 8, maximum: 600 }),
  color: str('Color del texto en hexadecimal, p. ej. #ffffff.'),
  fuente: str(`Fuente: ${FONTS.map((f) => f.family).join(', ')}.`),
  grosor: int('Grosor de la letra: 400 normal, 700 negrita, 900 muy gruesa.', { minimum: 100, maximum: 900 }),
  cursiva: bool('Letra cursiva.'),
  mayusculas: bool('Mostrar todo en mayúsculas.'),
  alineacion: str('Alineación de las líneas.', { enum: ['left', 'center', 'right'] }),
  contorno: num('Grosor del contorno en píxeles (0 = sin contorno).', { minimum: 0, maximum: 40 }),
  color_contorno: str('Color del contorno en hexadecimal.'),
  sombra: num('Desenfoque de la sombra en píxeles (0 = sin sombra).', { minimum: 0, maximum: 80 }),
  fondo: str('Color de un recuadro detrás del texto, en hexadecimal.'),
  opacidad_fondo: num('Opacidad del recuadro de fondo, de 0 (sin recuadro) a 1.', { minimum: 0, maximum: 1 }),
  animacion_entrada: ANIM_IN,
  animacion_salida: ANIM_OUT,
};

const ADJUST = obj({
  brillo: num('−100 a 100'),
  contraste: num('−100 a 100'),
  saturacion: num('−100 a 100'),
  tono: num('Giro de color, −180 a 180 grados'),
  temperatura: num('−100 (frío) a 100 (cálido)'),
  matiz: num('−100 (verde) a 100 (magenta)'),
  sepia: num('0 a 100'),
  blanco_negro: num('0 a 100'),
  desenfoque: num('0 a 40 px'),
  vineta: num('0 a 100'),
});

// ---------- Herramientas ----------
export const AI_TOOLS = [
  {
    name: 'ver_proyecto',
    title: 'Ver proyecto',
    description:
      'Describe el proyecto abierto en LiteCut: nombre, lienzo (ancho×alto, formato, fps), duración, pistas, clips (id, tipo, pista, inicio, fin, medio, velocidad, texto…), medios importados (id, ruta, duración, tamaño, estado), posición del cursor y si se puede deshacer. Llámala primero para conocer los ids.',
    inputSchema: obj({}),
    annotations: T,
  },
  {
    name: 'ver_clip',
    title: 'Ver clip',
    description: 'Muestra todas las propiedades de un clip: tramo de la fuente, transformación, recorte, color, animaciones, audio y estilo de texto.',
    inputSchema: obj({ clip: CLIP }, ['clip']),
    annotations: T,
  },
  {
    name: 'importar_medios',
    title: 'Importar medios',
    description:
      'Importa videos, fotos o audio de este equipo a la biblioteca del proyecto (rutas absolutas). Con agregar=true además los coloca en la línea de tiempo: videos y fotos al final de la pista principal, audio desde el inicio en una pista de audio. Devuelve los ids de los medios (y de los clips).',
    inputSchema: obj(
      {
        rutas: list('Rutas absolutas de los archivos, p. ej. C:\\Users\\Ana\\Videos\\clase.mp4.'),
        agregar: bool('Además, añadirlos a la línea de tiempo.'),
      },
      ['rutas']
    ),
    annotations: { ...EDIT, idempotentHint: true },
  },
  {
    name: 'agregar_clip',
    title: 'Añadir clip',
    description:
      'Añade a la línea de tiempo un medio ya importado. Por defecto: video o foto al final de la pista principal (V1); audio desde el inicio en una pista de audio libre. En la pista principal, insertar en medio desplaza los clips siguientes.',
    inputSchema: obj(
      {
        medio: MEDIA,
        inicio: num('Instante de la línea de tiempo donde empieza.', { minimum: 0 }),
        pista: TRACK,
        entrada: num('Segundo del archivo desde el que empieza el clip (para usar solo una parte).', { minimum: 0 }),
        duracion: num('Duración en la línea de tiempo (por defecto todo el archivo, o 5 s para una foto).', { minimum: 0.1 }),
      },
      ['medio']
    ),
    annotations: EDIT,
  },
  {
    name: 'dividir',
    title: 'Dividir',
    description:
      'Divide en el instante indicado el clip dado o, si no se indica clip, todos los clips (de pistas sin bloquear) que pasan por ese instante. El audio separado de un video se divide con él. Devuelve los ids de las partes derechas (nuevas).',
    inputSchema: obj({ tiempo: num('Instante de la línea de tiempo.', { minimum: 0 }), clip: CLIP }, ['tiempo']),
    annotations: EDIT,
  },
  {
    name: 'recortar_clip',
    title: 'Recortar clip',
    description:
      'Recorta (o alarga, con valores negativos) los bordes de un clip. Usa quitar_inicio/quitar_final (segundos que se quitan) o nuevo_inicio/nuevo_fin (instante de la línea de tiempo donde quedará cada borde). En la pista principal el clip no se mueve y los siguientes se desplazan para no dejar huecos.',
    inputSchema: obj(
      {
        clip: CLIP,
        quitar_inicio: num('Segundos que se quitan del principio.'),
        quitar_final: num('Segundos que se quitan del final.'),
        nuevo_inicio: num('Instante donde quedará el borde izquierdo.', { minimum: 0 }),
        nuevo_fin: num('Instante donde quedará el borde derecho.', { minimum: 0 }),
      },
      ['clip']
    ),
    annotations: EDIT,
  },
  {
    name: 'mover_clip',
    title: 'Mover clip',
    description:
      'Mueve un clip a otro instante y, si se indica, a otra pista. En la pista principal se inserta desplazando los siguientes; en las demás, si el hueco está ocupado, se usa otra pista libre. El audio separado sigue a su video.',
    inputSchema: obj({ clip: CLIP, inicio: num('Nuevo instante de inicio.', { minimum: 0 }), pista: TRACK }, ['clip', 'inicio']),
    annotations: EDIT,
  },
  {
    name: 'eliminar_clips',
    title: 'Eliminar clips',
    description: 'Elimina clips de la línea de tiempo. Con cerrar_hueco=true los clips siguientes de cada pista se adelantan para tapar el hueco.',
    inputSchema: obj({ clips: list('Ids de los clips.'), cerrar_hueco: bool('Adelantar lo que viene después para no dejar huecos.') }, ['clips']),
    annotations: { ...EDIT, destructiveHint: true },
  },
  {
    name: 'eliminar_tramo',
    title: 'Eliminar tramo',
    description:
      'Quita de una pista el tramo de tiempo [inicio, fin) y junta lo que queda (lo que va después en esa pista se adelanta). Ideal para cortar una parte de un video. El audio separado de esos videos se corta con ellos; las demás pistas no se mueven.',
    inputSchema: obj(
      {
        inicio: num('Inicio del tramo.', { minimum: 0 }),
        fin: num('Fin del tramo.', { minimum: 0 }),
        pista: str('Pista (por defecto V1, la principal).'),
      },
      ['inicio', 'fin']
    ),
    annotations: { ...EDIT, destructiveHint: true },
  },
  {
    name: 'cambiar_velocidad',
    title: 'Cambiar velocidad',
    description:
      'Cambia la velocidad de un clip de video o audio (2 = el doble de rápido, 0.5 = cámara lenta; la voz conserva el tono). Cambia su duración y, en la pista principal, desplaza los siguientes.',
    inputSchema: obj({ clip: CLIP, velocidad: num('Velocidad, de 0.1 a 16.', { minimum: 0.1, maximum: 16 }) }, ['clip', 'velocidad']),
    annotations: EDIT,
  },
  {
    name: 'ajustar_clip',
    title: 'Ajustar clip',
    description:
      'Cambia propiedades de uno o varios clips: volumen, silencio, fundidos de sonido, posición, escala, giro, opacidad, volteo, recorte, máscara, fondo desenfocado, animaciones, Ken Burns y duración. Solo cambia lo que se indique.',
    inputSchema: obj({
      clip: CLIP,
      clips: list('Varios clips a la vez (en lugar de clip).'),
      volumen: num('Volumen, de 0 a 2 (1 = original).', { minimum: 0, maximum: 2 }),
      silenciar: bool('true silencia el clip; false le devuelve el sonido (y une el audio separado de un video).'),
      fundido_entrada: num('Fundido de sonido al empezar, en segundos.', { minimum: 0, maximum: 10 }),
      fundido_salida: num('Fundido de sonido al terminar, en segundos.', { minimum: 0, maximum: 10 }),
      x: num('Posición horizontal del centro en píxeles desde el centro del lienzo.'),
      y: num('Posición vertical del centro en píxeles desde el centro del lienzo.'),
      escala: num('Tamaño (1 = ajustado al lienzo).', { minimum: 0.05, maximum: 10 }),
      rotacion: num('Giro en grados.', { minimum: -360, maximum: 360 }),
      opacidad: num('Opacidad de 0 a 1.', { minimum: 0, maximum: 1 }),
      voltear_horizontal: bool('Espejo horizontal.'),
      voltear_vertical: bool('Espejo vertical.'),
      recorte: obj({
        izquierda: num('Fracción que se recorta (0 a 0.95).', { minimum: 0, maximum: 0.95 }),
        arriba: num('Fracción que se recorta (0 a 0.95).', { minimum: 0, maximum: 0.95 }),
        derecha: num('Fracción que se recorta (0 a 0.95).', { minimum: 0, maximum: 0.95 }),
        abajo: num('Fracción que se recorta (0 a 0.95).', { minimum: 0, maximum: 0.95 }),
      }),
      mascara: str(`Máscara: ${list2(MASKS)}.`, { enum: MASKS.map((m) => m.id) }),
      fondo: str('Relleno de las barras en la pista principal: «color» (color de fondo) o «desenfoque» (el mismo video desenfocado).', { enum: ['color', 'desenfoque'] }),
      animacion_entrada: ANIM_IN,
      animacion_salida: ANIM_OUT,
      duracion_animacion: num('Duración de las animaciones de entrada y salida, en segundos.', { minimum: 0.1, maximum: 3 }),
      ken_burns: str(`Movimiento lento de cámara: ${list2(KENBURNS)}.`, { enum: KENBURNS.map((k) => k.id) }),
      duracion: num('Nueva duración en la línea de tiempo (en la principal desplaza los siguientes).', { minimum: 0.1 }),
    }),
    annotations: EDIT,
  },
  {
    name: 'agregar_texto',
    title: 'Añadir texto',
    description:
      'Añade un texto (título, subtítulo, rótulo…) en una pista superior. Por defecto empieza en el cursor, dura 4 s y se ajusta para caber en el ancho del lienzo. Devuelve el id del clip; comprueba cómo queda con ver_fotograma.',
    inputSchema: obj(
      {
        ...TEXT_STYLE,
        texto: str('Contenido del texto. Usa \\n para varias líneas.'),
        inicio: num('Instante de inicio.', { minimum: 0 }),
        duracion: num('Duración en segundos.', { minimum: 0.1 }),
      },
      ['texto']
    ),
    annotations: EDIT,
  },
  {
    name: 'editar_texto',
    title: 'Editar texto',
    description: 'Cambia el contenido o el estilo de un clip de texto. Solo cambia lo que se indique; estilo aplica un estilo rápido completo.',
    inputSchema: obj({ clip: CLIP, ...TEXT_STYLE }, ['clip']),
    annotations: EDIT,
  },
  {
    name: 'poner_transicion',
    title: 'Poner transición',
    description:
      'Pone (o cambia) una transición entre dos clips seguidos de la pista principal. Indica el clip que entra (el segundo) o un tiempo cercano a la unión. Los clips se solapan durante la transición, así que el video se acorta un poco.',
    inputSchema: obj({
      clip: str('Id del clip que entra (el de después de la unión).'),
      tiempo: num('En lugar de clip: la unión más cercana a este instante.', { minimum: 0 }),
      tipo: str(`Tipo: ${list2(TRANSITIONS)}. Por defecto fade.`, { enum: TRANSITIONS.map((t) => t.id) }),
      duracion: num('Duración en segundos (por defecto 0.6).', { minimum: 0.1, maximum: 5 }),
    }),
    annotations: EDIT,
  },
  {
    name: 'quitar_transicion',
    title: 'Quitar transición',
    description: 'Quita la transición de entrada de un clip de la pista principal.',
    inputSchema: obj({ clip: str('Id del clip que entra.') }, ['clip']),
    annotations: EDIT,
  },
  {
    name: 'aplicar_filtro',
    title: 'Aplicar filtro',
    description: 'Aplica un filtro de color predefinido y/o ajustes manuales a clips de video o foto (por defecto, a todos).',
    inputSchema: obj({
      clips: list('Ids de los clips (por defecto todos los videos y fotos).'),
      filtro: str(`Filtro: ${list2(FILTER_PRESETS)}. «none» quita el filtro.`, { enum: FILTER_PRESETS.map((f) => f.id) }),
      ajustes: { ...ADJUST, description: 'Ajustes manuales que se aplican encima del filtro.' },
    }),
    annotations: EDIT,
  },
  {
    name: 'configurar_proyecto',
    title: 'Configurar proyecto',
    description:
      'Cambia el lienzo (formato o tamaño), los fotogramas por segundo, el color de fondo o el nombre. Con relleno=desenfoque las barras de los clips de la pista principal se rellenan con el mismo video desenfocado (ideal para pasar un video horizontal a 9:16).',
    inputSchema: obj({
      formato: str(`Formato: ${ASPECTS.map((a) => `${a.id} (${a.sub})`).join(', ')}.`, { enum: ASPECTS.map((a) => a.id) }),
      ancho: int('Ancho personalizado en píxeles (par).', { minimum: 128, maximum: 7680 }),
      alto: int('Alto personalizado en píxeles (par).', { minimum: 128, maximum: 7680 }),
      fps: int('Fotogramas por segundo: 24, 25, 30, 50 o 60.', { minimum: 24, maximum: 60 }),
      fondo: str('Color de fondo en hexadecimal.'),
      nombre: str('Nombre del proyecto.'),
      relleno: str('Relleno de las barras de los clips de la pista principal.', { enum: ['color', 'desenfoque'] }),
    }),
    annotations: EDIT,
  },
  {
    name: 'ver_fotograma',
    title: 'Ver fotograma',
    description:
      'Devuelve una imagen pequeña de cómo se ve el proyecto en un instante (lo mismo que se exportará): sirve para revisar textos, encuadre y filtros. Mueve el cursor de LiteCut a ese instante.',
    inputSchema: obj({
      tiempo: num('Instante (por defecto, la posición del cursor).', { minimum: 0 }),
      ancho: int('Ancho de la imagen en píxeles (160 a 1280, por defecto 512).', { minimum: 160, maximum: 1280 }),
      formato: str('png (por defecto) o jpeg (más liviano).', { enum: ['png', 'jpeg'] }),
    }),
    annotations: T,
  },
  {
    name: 'exportar',
    title: 'Exportar',
    description:
      'Exporta el proyecto a un archivo con FFmpeg (usa la tarjeta gráfica si puede). Sin ruta se guarda en la carpeta de videos con el nombre del proyecto, sin sobrescribir nada. Informa del progreso; si tarda más de «esperar» segundos responde que sigue en curso (la exportación continúa) y puedes consultar estado_exportacion.',
    inputSchema: obj({
      ruta: str('Ruta absoluta del archivo de salida (la extensión se ajusta al formato).'),
      formato: str('mp4 (H.264, el más compatible; por defecto), mp4-hevc (H.265), webm, gif, mp3 o wav (solo audio).', { enum: ['mp4', 'mp4-hevc', 'webm', 'gif', 'mp3', 'wav'] }),
      resolucion: str('Tamaño de salida según el lado corto: proyecto (por defecto), 2160p, 1440p, 1080p, 720p, 480p o 360p.', { enum: ['proyecto', '2160p', '1440p', '1080p', '720p', '480p', '360p'] }),
      fps: int('Fotogramas por segundo: 24, 25, 30, 50 o 60 (GIF: 10, 12 o 15). Por defecto, los del proyecto.', { minimum: 10, maximum: 60 }),
      calidad: str('alta, recomendada (por defecto) o liviana.', { enum: ['alta', 'recomendada', 'liviana'] }),
      sobrescribir: bool('Permitir reemplazar un archivo existente.'),
      esperar: num('Segundos que se espera a que termine antes de responder (0 a 55, por defecto 40).', { minimum: 0, maximum: 55 }),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'estado_exportacion',
    title: 'Estado de la exportación',
    description: 'Progreso o resultado de la última exportación. Puede esperar unos segundos a que termine, o cancelarla.',
    inputSchema: obj({
      esperar: num('Segundos que se espera a que termine (0 a 55, por defecto 40).', { minimum: 0, maximum: 55 }),
      cancelar: bool('Cancelar la exportación en curso.'),
    }),
    annotations: { ...T, idempotentHint: false },
  },
  {
    name: 'deshacer',
    title: 'Deshacer',
    description: 'Deshace los últimos cambios del proyecto (como Ctrl+Z).',
    inputSchema: obj({ pasos: int('Cuántos cambios deshacer (por defecto 1).', { minimum: 1, maximum: 50 }) }),
    annotations: EDIT,
  },
  {
    name: 'rehacer',
    title: 'Rehacer',
    description: 'Vuelve a aplicar cambios deshechos (como Ctrl+Y).',
    inputSchema: obj({ pasos: int('Cuántos cambios rehacer (por defecto 1).', { minimum: 1, maximum: 50 }) }),
    annotations: EDIT,
  },
  {
    name: 'detectar_silencios',
    title: 'Detectar silencios',
    description:
      'Busca pausas en el sonido con FFmpeg, sin reproducir nada. Con clip (o sin nada: todos los clips con sonido de la pista principal) da los tramos en tiempos de la línea de tiempo; con medio, en segundos del archivo.',
    inputSchema: obj({
      clip: CLIP,
      medio: MEDIA,
      umbral_db: num('Volumen por debajo del cual se considera silencio, en dB (por defecto −35; −45 es más estricto).', { minimum: -80, maximum: -10 }),
      duracion_minima: num('Duración mínima de una pausa, en segundos (por defecto 0.5).', { minimum: 0.1, maximum: 10 }),
    }),
    annotations: T,
  },
  {
    name: 'cortar_silencios',
    title: 'Cortar silencios',
    description:
      'Quita las pausas de los clips con sonido de la pista principal (o de los clips indicados) y junta lo que queda, como un «jump cut». Deja un pequeño margen alrededor de la voz, respeta las transiciones y no borra un clip que esté en silencio de principio a fin. Es un solo paso de deshacer.',
    inputSchema: obj({
      clips: list('Ids de los clips (por defecto todos los de la pista principal con sonido).'),
      umbral_db: num('Volumen por debajo del cual se considera silencio, en dB (por defecto −35).', { minimum: -80, maximum: -10 }),
      duracion_minima: num('Duración mínima de una pausa para quitarla, en segundos (por defecto 0.6).', { minimum: 0.2, maximum: 10 }),
      margen: num('Silencio que se deja antes y después de cada parte con sonido, en segundos (por defecto 0.15).', { minimum: 0, maximum: 1 }),
    }),
    annotations: { ...EDIT, destructiveHint: true },
  },
  {
    name: 'detectar_escenas',
    title: 'Detectar escenas',
    description:
      'Detecta cambios de escena (cortes de cámara) con FFmpeg (filtro scdet), analizando a baja resolución para no cargar el equipo. En videos largos puede devolver un análisis parcial: continúa con inicio.',
    inputSchema: obj({
      clip: CLIP,
      medio: MEDIA,
      umbral: num('Sensibilidad de 1 a 100 (por defecto 12; más bajo detecta más cambios).', { minimum: 1, maximum: 100 }),
      inicio: num('Segundo del archivo desde el que se analiza.', { minimum: 0 }),
      duracion: num('Segundos a analizar.', { minimum: 1 }),
    }),
    annotations: T,
  },
  {
    name: 'fotogramas_de_muestra',
    title: 'Fotogramas de muestra',
    description:
      'Devuelve varias imágenes pequeñas repartidas a lo largo de un medio o de un clip, con su tiempo, para entender de qué trata un video sin reproducirlo. Para ver el resultado final (con textos y filtros) usa ver_fotograma.',
    inputSchema: obj({
      clip: CLIP,
      medio: MEDIA,
      cantidad: int('Cuántas imágenes (1 a 12, por defecto 6).', { minimum: 1, maximum: 12 }),
      ancho: int('Ancho de cada imagen en píxeles (160 a 640, por defecto 320).', { minimum: 160, maximum: 640 }),
      inicio: num('Desde este segundo (del archivo con medio, de la línea de tiempo con clip).', { minimum: 0 }),
      fin: num('Hasta este segundo.', { minimum: 0 }),
    }),
    annotations: T,
  },
  {
    name: 'detectar_ritmo',
    title: 'Detectar ritmo',
    description:
      'Analiza la música de un clip de audio (o de un video con sonido) y pone marcadores en sus pulsos: el usuario los ve en la regla y el imán se pega a ellos. Devuelve el tempo (BPM) y el instante de la línea de tiempo de cada pulso, para cortar o colocar clips al ritmo (dividir, recortar_clip, mover_clip).',
    inputSchema: obj({ clip: CLIP }, ['clip']),
    annotations: EDIT,
  },
  {
    name: 'aplicar_efecto',
    title: 'Aplicar efecto',
    description: `Pone o quita un efecto en clips de video, foto o texto: ${list2(EFFECTS)}. «zoom-pulse» sigue los marcadores de ritmo de su tramo si existen (usa antes detectar_ritmo). Un clip puede tener varios efectos; volver a ponerlo cambia su intensidad.`,
    inputSchema: obj(
      {
        clips: list('Ids de los clips.'),
        efecto: str('Efecto.', { enum: EFFECTS.map((e) => e.id) }),
        intensidad: num('De 0.1 a 1 (por defecto 0.5).', { minimum: 0.1, maximum: 1 }),
        quitar: bool('Quitar el efecto en vez de ponerlo.'),
      },
      ['clips', 'efecto']
    ),
    annotations: EDIT,
  },
  {
    name: 'invertir_clip',
    title: 'Invertir clip',
    description:
      'Hace que un clip de video o de audio se reproduzca hacia atrás (crea una copia invertida del tramo que usa; en equipos modestos tarda unos segundos por cada segundo de clip). Si el clip ya estaba invertido, vuelve a reproducirse hacia delante.',
    inputSchema: obj({ clip: CLIP }, ['clip']),
    annotations: EDIT,
  },
  {
    name: 'normalizar_volumen',
    title: 'Normalizar volumen',
    description:
      'Mide la sonoridad de clips con sonido y ajusta su volumen a −14 LUFS (lo habitual en YouTube, TikTok o Spotify) sin pasar de −1 dB de pico. Sirve para igualar voces o músicas que suenan muy bajo o muy alto.',
    inputSchema: obj({ clips: list('Ids de los clips con sonido.') }, ['clips']),
    annotations: EDIT,
  },
  {
    name: 'dividir_por_escenas',
    title: 'Dividir por escenas',
    description: 'Divide de una vez un clip de video en cada cambio de plano (escena). Devuelve los ids de los trozos, en orden.',
    inputSchema: obj({ clip: CLIP }, ['clip']),
    annotations: EDIT,
  },
  {
    name: 'guardar_proyecto',
    title: 'Guardar proyecto',
    description: 'Guarda el proyecto (.lcproj). Sin ruta lo guarda en su archivo actual o, si es nuevo, en Documentos con su nombre (sin sobrescribir otros archivos).',
    inputSchema: obj({ ruta: str('Ruta absoluta del archivo .lcproj.') }),
    annotations: { ...EDIT, idempotentHint: true },
  },
];

export const AI_TOOL_MAP = new Map(AI_TOOLS.map((t) => [t.name, t]));

// Lista para el protocolo MCP (tools/list).
export function mcpToolList() {
  return AI_TOOLS.map(({ name, title, description, inputSchema, annotations }) => ({ name, title, description, inputSchema, annotations }));
}

// ---------- Validación de argumentos ----------
// Comprueba los argumentos contra el esquema de la herramienta: tipos, obligatorios, valores permitidos y rangos.
// Convierte números escritos como texto ("5" → 5). Ignora parámetros desconocidos. Lanza un Error en español.
export function validateArgs(toolName, args) {
  const def = AI_TOOL_MAP.get(toolName);
  if (!def) throw new Error(`Herramienta desconocida: ${toolName}`);
  return checkValue(def.inputSchema, args ?? {}, '');
}

function checkValue(schema, v, path) {
  const name = path || 'argumentos';
  switch (schema.type) {
    case 'object': {
      if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error(`«${name}» debe ser un objeto.`);
      const out = {};
      for (const k of schema.required || []) if (v[k] === undefined || v[k] === null || v[k] === '') throw new Error(`Falta el parámetro «${path ? `${path}.` : ''}${k}».`);
      for (const [k, sub] of Object.entries(schema.properties || {})) {
        if (v[k] === undefined || v[k] === null) continue;
        out[k] = checkValue(sub, v[k], path ? `${path}.${k}` : k);
      }
      return out;
    }
    case 'array': {
      const arr = Array.isArray(v) ? v : [v];
      return arr.map((x, i) => checkValue(schema.items || {}, x, `${name}[${i}]`));
    }
    case 'number':
    case 'integer': {
      const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
      if (typeof n !== 'number' || !Number.isFinite(n)) throw new Error(`«${name}» debe ser un número.`);
      if (schema.type === 'integer' && !Number.isInteger(n)) throw new Error(`«${name}» debe ser un número entero.`);
      if (schema.minimum !== undefined && n < schema.minimum) throw new Error(`«${name}» debe ser como mínimo ${schema.minimum}.`);
      if (schema.maximum !== undefined && n > schema.maximum) throw new Error(`«${name}» debe ser como máximo ${schema.maximum}.`);
      if (schema.enum && !schema.enum.includes(n)) throw new Error(`«${name}» debe ser uno de: ${schema.enum.join(', ')}.`);
      return n;
    }
    case 'boolean': {
      if (v === 'true' || v === 'false') return v === 'true';
      if (typeof v !== 'boolean') throw new Error(`«${name}» debe ser true o false.`);
      return v;
    }
    case 'string': {
      if (typeof v === 'number') v = String(v);
      if (typeof v !== 'string') throw new Error(`«${name}» debe ser un texto.`);
      if (schema.enum && !schema.enum.includes(v)) throw new Error(`«${name}» debe ser uno de: ${schema.enum.join(', ')}.`);
      return v;
    }
    default:
      return v;
  }
}
