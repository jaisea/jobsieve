/**
 * The tray icon, drawn from a number.
 *
 * Windows has no badge API for a tray icon — only a taskbar button can carry an
 * overlay — so the count has to BE the icon. This draws it straight into a PNG:
 * a rounded square with the digits on it, no canvas and no image library, which
 * also means it runs (and is tested) outside Electron.
 */
import { deflateSync } from 'node:zlib';

/** 3x5 pixel glyphs. Two digits fit a 32px icon at scale 4; one gets scale 5. */
const GLYPHS = {
  0: ['111', '101', '101', '101', '111'],
  1: ['010', '110', '010', '010', '111'],
  2: ['111', '001', '111', '100', '111'],
  3: ['111', '001', '111', '001', '111'],
  4: ['101', '101', '111', '001', '001'],
  5: ['111', '100', '111', '001', '111'],
  6: ['111', '100', '111', '101', '111'],
  7: ['111', '001', '001', '001', '001'],
  8: ['111', '101', '111', '101', '111'],
  9: ['111', '101', '111', '001', '111'],
  '!': ['010', '010', '010', '000', '010'],
  // Only for the window icon, which spells JH.
  J: ['001', '001', '001', '101', '010'],
  H: ['101', '101', '111', '101', '101'],
};

/** idle: nothing waiting. open: something is. error: the last scan failed, which must not look like "nothing new". */
const TONES = {
  idle: [107, 114, 128],
  open: [37, 99, 235],
  error: [220, 38, 38],
  // The taskbar badge: red, the colour messaging apps use for "something is waiting".
  alert: [229, 57, 53],
};

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(body));
  return Buffer.concat([head, body, tail]);
}

/** What goes on the icon: digits capped at two places, or "!" for an error. */
export function labelFor(count, tone = 'open') {
  if (tone === 'error') return '!';
  return String(Math.max(0, Math.min(99, Math.trunc(Number(count)) || 0)));
}

/**
 * A square PNG, RGBA, with `label` (one or two glyphs) centred on a rounded block —
 * or, with `shape: 'circle'`, on a round badge. A circle has less room in its
 * corners, so two digits are drawn smaller there.
 */
export function badgePng(label, { tone = 'open', size = 32, shape = 'square' } = {}) {
  const [r, g, b] = TONES[tone] || TONES.open;
  const circle = shape === 'circle';
  const rows = [...String(label)].map((ch) => GLYPHS[ch]).filter(Boolean).slice(0, 2);
  // 5 and 4 are right at 32px; a larger icon (the window's) scales the pixels up.
  const base = rows.length === 1 ? 5 : circle ? 3 : 4;
  const scale = Math.max(1, Math.round(base * (size / 32)));
  const textW = rows.length ? rows.length * 3 * scale + (rows.length - 1) * scale : 0;
  const textH = 5 * scale;
  const x0 = Math.floor((size - textW) / 2);
  const y0 = Math.floor((size - textH) / 2);
  const radius = Math.round(size * 0.22);

  const inside = (x, y) => {
    if (circle) return (x - (size - 1) / 2) ** 2 + (y - (size - 1) / 2) ** 2 <= (size / 2) ** 2;
    const cx = x < radius ? radius : x >= size - radius ? size - radius - 1 : x;
    const cy = y < radius ? radius : y >= size - radius ? size - radius - 1 : y;
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
  };

  const lit = (x, y) => {
    if (x < x0 || y < y0 || y >= y0 + textH) return false;
    const gx = Math.floor((x - x0) / scale);
    const gy = Math.floor((y - y0) / scale);
    const slot = Math.floor(gx / 4);
    const col = gx % 4;
    return slot < rows.length && col < 3 && gx < rows.length * 4 - 1 && rows[slot][gy][col] === '1';
  };

  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1);
    raw[row] = 0;
    for (let x = 0; x < size; x++) {
      const o = row + 1 + x * 4;
      if (!inside(x, y)) continue;
      const on = lit(x, y);
      raw[o] = on ? 255 : r;
      raw[o + 1] = on ? 255 : g;
      raw[o + 2] = on ? 255 : b;
      raw[o + 3] = 255;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
