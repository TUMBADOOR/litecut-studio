// Copia las fuentes (licencia SIL OFL) desde @fontsource a src/renderer/fonts y genera css/fonts.css.
// Uso: npm run fonts
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'src', 'renderer', 'fonts');
const cssFile = path.join(root, 'src', 'renderer', 'css', 'fonts.css');

const FONTS = [
  { pkg: 'montserrat', family: 'Montserrat', normal: [400, 600, 700, 800, 900], italic: [700, 800] },
  { pkg: 'poppins', family: 'Poppins', normal: [400, 600, 700, 800], italic: [600] },
  { pkg: 'oswald', family: 'Oswald', normal: [400, 500, 700], italic: [] },
  { pkg: 'bebas-neue', family: 'Bebas Neue', normal: [400], italic: [] },
  { pkg: 'anton', family: 'Anton', normal: [400], italic: [] },
  { pkg: 'bangers', family: 'Bangers', normal: [400], italic: [] },
  { pkg: 'permanent-marker', family: 'Permanent Marker', normal: [400], italic: [] },
  { pkg: 'pacifico', family: 'Pacifico', normal: [400], italic: [] },
  { pkg: 'lobster', family: 'Lobster', normal: [400], italic: [] },
  { pkg: 'dancing-script', family: 'Dancing Script', normal: [400, 700], italic: [] },
  { pkg: 'caveat', family: 'Caveat', normal: [400, 700], italic: [] },
  { pkg: 'playfair-display', family: 'Playfair Display', normal: [400, 700, 900], italic: [400, 700] },
];

fs.mkdirSync(outDir, { recursive: true });
const css = ['/* Generado por scripts/copy-fonts.js — fuentes con licencia SIL Open Font License */'];
let count = 0;
for (const f of FONTS) {
  const src = path.join(root, 'node_modules', '@fontsource', f.pkg, 'files');
  for (const [style, weights] of [['normal', f.normal], ['italic', f.italic]]) {
    for (const w of weights) {
      const name = `${f.pkg}-latin-${w}-${style}.woff2`;
      const from = path.join(src, name);
      if (!fs.existsSync(from)) {
        console.warn(`Falta ${name}`);
        continue;
      }
      fs.copyFileSync(from, path.join(outDir, name));
      css.push(`@font-face { font-family: '${f.family}'; font-style: ${style}; font-weight: ${w}; font-display: block; src: url('../fonts/${name}') format('woff2'); }`);
      count++;
    }
  }
  const lic = path.join(root, 'node_modules', '@fontsource', f.pkg, 'LICENSE');
  if (fs.existsSync(lic)) fs.copyFileSync(lic, path.join(outDir, `LICENSE-${f.pkg}.txt`));
}
fs.writeFileSync(cssFile, `${css.join('\n')}\n`);
console.log(`${count} archivos de fuente copiados a ${path.relative(root, outDir)}`);
