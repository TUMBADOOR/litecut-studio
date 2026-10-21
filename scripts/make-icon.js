// Genera el ícono de la app (PNG) sin dependencias: degradado + botón de reproducir + punto de grabación.
// Uso: npm run icon
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePng(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const sdRoundRect = (x, y, cx, cy, hw, hh, r) => {
  const qx = Math.abs(x - cx) - (hw - r);
  const qy = Math.abs(y - cy) - (hh - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
};
const sdCircle = (x, y, cx, cy, r) => Math.hypot(x - cx, y - cy) - r;
// Triángulo (distancia con signo, de Inigo Quilez)
function sdTriangle(px, py, p0, p1, p2) {
  const e0 = [p1[0] - p0[0], p1[1] - p0[1]];
  const e1 = [p2[0] - p1[0], p2[1] - p1[1]];
  const e2 = [p0[0] - p2[0], p0[1] - p2[1]];
  const v0 = [px - p0[0], py - p0[1]];
  const v1 = [px - p1[0], py - p1[1]];
  const v2 = [px - p2[0], py - p2[1]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
  const clamp = (v) => Math.min(1, Math.max(0, v));
  const pq = (v, e) => {
    const t = clamp(dot(v, e) / dot(e, e));
    return [v[0] - e[0] * t, v[1] - e[1] * t];
  };
  const q0 = pq(v0, e0);
  const q1 = pq(v1, e1);
  const q2 = pq(v2, e2);
  const s = Math.sign(e0[0] * e2[1] - e0[1] * e2[0]);
  const d0 = [dot(q0, q0), s * (v0[0] * e0[1] - v0[1] * e0[0])];
  const d1 = [dot(q1, q1), s * (v1[0] * e1[1] - v1[1] * e1[0])];
  const d2 = [dot(q2, q2), s * (v2[0] * e2[1] - v2[1] * e2[0])];
  const md = Math.min(d0[0], d1[0], d2[0]);
  const ms = Math.min(d0[1], d1[1], d2[1]);
  return -Math.sqrt(md) * Math.sign(ms);
}

function render(S) {
  const k = S / 1024;
  const buf = Buffer.alloc(S * S * 4);
  const over = (i, r, g, b, a) => {
    if (a <= 0) return;
    const da = buf[i + 3] / 255;
    const oa = a + da * (1 - a);
    buf[i] = Math.round((r * a + buf[i] * da * (1 - a)) / oa);
    buf[i + 1] = Math.round((g * a + buf[i + 1] * da * (1 - a)) / oa);
    buf[i + 2] = Math.round((b * a + buf[i + 2] * da * (1 - a)) / oa);
    buf[i + 3] = Math.round(oa * 255);
  };
  const cov = (d) => Math.min(1, Math.max(0, 0.5 - d));
  const tri = [
    [400 * k, 330 * k],
    [400 * k, 700 * k],
    [710 * k, 515 * k],
  ];
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const i = (y * S + x) * 4;
      // Fondo: cuadrado redondeado con degradado turquesa → índigo
      const dBg = sdRoundRect(px, py, 512 * k, 512 * k, 448 * k, 448 * k, 210 * k);
      const t = Math.min(1, Math.max(0, (px + py) / (2 * S)));
      const r = Math.round(25 + (58 - 25) * t);
      const g = Math.round(211 + (92 - 211) * t);
      const b = Math.round(197 + (240 - 197) * t);
      over(i, r, g, b, cov(dBg));
      // Brillo sutil arriba
      const dGloss = sdRoundRect(px, py, 512 * k, 300 * k, 420 * k, 210 * k, 190 * k);
      over(i, 255, 255, 255, cov(Math.max(dGloss, dBg)) * 0.08);
      // Botón de reproducir (redondeado)
      const dTri = sdTriangle(px, py, ...tri) - 34 * k;
      over(i, 255, 255, 255, cov(dTri));
      // Punto de grabación con borde blanco
      over(i, 255, 255, 255, cov(sdCircle(px, py, 770 * k, 262 * k, 118 * k)));
      over(i, 255, 59, 78, cov(sdCircle(px, py, 770 * k, 262 * k, 90 * k)));
    }
  }
  return encodePng(S, S, buf);
}

// .ico de Windows: varias imágenes PNG dentro de un contenedor ICO.
function encodeIco(sizes) {
  const pngs = sizes.map((s) => render(s));
  const header = Buffer.alloc(6 + 16 * sizes.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  sizes.forEach((s, i) => {
    const e = 6 + i * 16;
    header[e] = s >= 256 ? 0 : s;
    header[e + 1] = s >= 256 ? 0 : s;
    header.writeUInt16LE(1, e + 4);
    header.writeUInt16LE(32, e + 6);
    header.writeUInt32LE(pngs[i].length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += pngs[i].length;
  });
  return Buffer.concat([header, ...pngs]);
}

// .icns de macOS con entradas PNG (macOS 10.7+).
function encodeIcns() {
  const entries = [
    ['ic11', 32],
    ['ic12', 64],
    ['ic07', 128],
    ['ic13', 256],
    ['ic08', 256],
    ['ic14', 512],
    ['ic09', 512],
    ['ic10', 1024],
  ];
  const cache = new Map();
  const parts = entries.map(([type, size]) => {
    if (!cache.has(size)) cache.set(size, render(size));
    const png = cache.get(size);
    const head = Buffer.alloc(8);
    head.write(type, 0, 'ascii');
    head.writeUInt32BE(png.length + 8, 4);
    return Buffer.concat([head, png]);
  });
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(8);
  head.write('icns', 0, 'ascii');
  head.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([head, body]);
}

const write = (file, data, label) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
  console.log(`${label}: ${path.relative(root, file)}`);
};
write(path.join(root, 'build', 'icon.png'), render(1024), 'Ícono 1024×1024');
write(path.join(root, 'src', 'renderer', 'assets', 'icon.png'), render(256), 'Ícono 256×256');
write(path.join(root, 'build', 'icon.ico'), encodeIco([16, 24, 32, 48, 64, 128, 256]), 'Ícono de Windows');
write(path.join(root, 'build', 'icon.icns'), encodeIcns(), 'Ícono de macOS');
