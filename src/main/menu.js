import { Menu, app } from 'electron';

// Menú de la aplicación. Las acciones se envían a la interfaz, que decide qué hacer
// (por ejemplo, Deshacer en un campo de texto deshace el texto, no la línea de tiempo).
export function buildMenu(send, { isMac }) {
  const cmd = (id) => () => send(id);
  const template = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { label: 'Acerca de LiteCut Studio', click: cmd('about') },
              { type: 'separator' },
              { role: 'services', label: 'Servicios' },
              { type: 'separator' },
              { role: 'hide', label: 'Ocultar LiteCut Studio' },
              { role: 'hideOthers', label: 'Ocultar otros' },
              { role: 'unhide', label: 'Mostrar todo' },
              { type: 'separator' },
              { role: 'quit', label: 'Salir de LiteCut Studio' },
            ],
          },
        ]
      : []),
    {
      label: 'Archivo',
      submenu: [
        { label: 'Nuevo proyecto', accelerator: 'CmdOrCtrl+N', click: cmd('new') },
        { label: 'Abrir proyecto…', accelerator: 'CmdOrCtrl+O', click: cmd('open') },
        { type: 'separator' },
        { label: 'Guardar', accelerator: 'CmdOrCtrl+S', click: cmd('save') },
        { label: 'Guardar como…', accelerator: 'CmdOrCtrl+Shift+S', click: cmd('saveAs') },
        { type: 'separator' },
        { label: 'Importar medios…', accelerator: 'CmdOrCtrl+I', click: cmd('import') },
        { label: 'Grabar pantalla…', accelerator: 'CmdOrCtrl+Shift+R', click: cmd('record') },
        { label: 'Grabar voz en off…', click: cmd('voiceover') },
        { type: 'separator' },
        { label: 'Exportar video…', accelerator: 'CmdOrCtrl+E', click: cmd('export') },
        ...(isMac ? [] : [{ type: 'separator' }, { role: 'quit', label: 'Salir' }]),
      ],
    },
    {
      label: 'Editar',
      submenu: [
        { label: 'Deshacer', accelerator: 'CmdOrCtrl+Z', click: cmd('undo') },
        { label: 'Rehacer', accelerator: isMac ? 'Cmd+Shift+Z' : 'Ctrl+Y', click: cmd('redo') },
        { type: 'separator' },
        { role: 'cut', label: 'Cortar' },
        { role: 'copy', label: 'Copiar' },
        { role: 'paste', label: 'Pegar' },
        { label: 'Seleccionar todo', accelerator: 'CmdOrCtrl+A', click: cmd('selectAll') },
        { type: 'separator' },
        { label: 'Dividir en el cursor', accelerator: 'CmdOrCtrl+B', click: cmd('split') },
        { label: 'Duplicar', accelerator: 'CmdOrCtrl+D', click: cmd('duplicate') },
        { label: 'Eliminar', accelerator: 'Delete', registerAccelerator: false, click: cmd('delete') },
        { label: 'Eliminar y cerrar hueco', accelerator: 'Shift+Delete', registerAccelerator: false, click: cmd('rippleDelete') },
      ],
    },
    {
      label: 'Ver',
      submenu: [
        { label: 'Acercar línea de tiempo', accelerator: 'CmdOrCtrl+=', click: cmd('zoomIn') },
        { label: 'Alejar línea de tiempo', accelerator: 'CmdOrCtrl+-', click: cmd('zoomOut') },
        { label: 'Ajustar línea de tiempo', accelerator: 'Shift+Z', registerAccelerator: false, click: cmd('zoomFit') },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Pantalla completa' },
        { type: 'separator' },
        { role: 'toggleDevTools', label: 'Herramientas de desarrollo' },
      ],
    },
    {
      label: 'Ayuda',
      submenu: [
        { label: 'Atajos de teclado', accelerator: 'F1', click: cmd('shortcuts') },
        { label: 'Acerca de LiteCut Studio', click: cmd('about') },
      ],
    },
  ];
  return Menu.buildFromTemplate(template);
}
