// Generates a 1024x1024 placeholder PNG with the MultiZone "M" mark.
// Pure stdlib: no canvas/sharp dependency.
import zlib from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { Buffer } from "node:buffer";

const SIZE = 1024;

function makePixel(r, g, b, a = 255) {
  return [r, g, b, a];
}

// Background gradient + simple "M" shape composed of rectangles.
const bg = makePixel(0x14, 0x17, 0x1c);
const accent = makePixel(0x4f, 0x9c, 0xf9);
const accentDim = makePixel(0x6a, 0xaf, 0xfa);

// "M" geometry within the 1024 canvas
const stroke = 96;
const leftX = 224;
const rightX = SIZE - 224 - stroke;
const topY = 224;
const bottomY = SIZE - 224;
const midX = SIZE / 2;
const midY = topY + 380;

function inRect(x, y, x0, y0, x1, y1) {
  return x >= x0 && x < x1 && y >= y0 && y < y1;
}

function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
let off = 0;
for (let y = 0; y < SIZE; y++) {
  raw[off++] = 0; // filter byte
  for (let x = 0; x < SIZE; x++) {
    // Background with subtle radial vignette
    const cx = SIZE / 2;
    const cy = SIZE / 2;
    const d = Math.hypot(x - cx, y - cy) / (SIZE / 2);
    const shade = Math.max(0, 1 - d * 0.4);
    let r = Math.round(bg[0] * (0.6 + 0.4 * shade));
    let g = Math.round(bg[1] * (0.6 + 0.4 * shade));
    let b = Math.round(bg[2] * (0.6 + 0.4 * shade));

    // Draw two diagonals of the "M"
    const dLeft = distToSegment(x, y, leftX + stroke / 2, topY, midX, midY);
    const dRight = distToSegment(x, y, rightX + stroke / 2, topY, midX, midY);
    const inLeftBar = inRect(x, y, leftX, topY, leftX + stroke, bottomY);
    const inRightBar = inRect(x, y, rightX, topY, rightX + stroke, bottomY);

    if (dLeft < stroke / 2.2 || dRight < stroke / 2.2) {
      r = accent[0]; g = accent[1]; b = accent[2];
    }
    if (inLeftBar || inRightBar) {
      r = accentDim[0]; g = accentDim[1]; b = accentDim[2];
    }

    raw[off++] = r;
    raw[off++] = g;
    raw[off++] = b;
    raw[off++] = 255;
  }
}

const compressed = zlib.deflateSync(raw, { level: 9 });

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

// CRC32
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
ihdr[10] = 0;
ihdr[11] = 0;
ihdr[12] = 0;
const idat = chunk("IDAT", compressed);
const iend = chunk("IEND", Buffer.alloc(0));
const png = Buffer.concat([sig, chunk("IHDR", ihdr), idat, iend]);

mkdirSync("src-tauri/icons", { recursive: true });
writeFileSync("src-tauri/icons/source.png", png);
console.log("wrote src-tauri/icons/source.png (1024x1024)");
