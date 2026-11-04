'use strict';
// Generates the app and tray icons as PNG files with no external tools:
// shapes are rasterized with supersampling and written by a tiny PNG encoder.
// Same recipe as ClipBridge (family gradient, white glyph, indigo arrows),
// with a folder instead of a clipboard and the gradient's hue shifted a little
// so the two apps are easy to tell apart in the taskbar.
//
//   node scripts/make-icons.js              the app's icons
//   node scripts/make-icons.js --variants   variants to compare (dev/sandbox/icon-variants)
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// The chosen look: the glyph style and how many degrees the family gradient
// is rotated on the color wheel (0 = ClipBridge's colors).
const ICON = { glyph: 'solid', hue: -40 };

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePNG(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const stride = w * 4 + 1;
  const raw = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) rgba.copy(raw, y * stride + 1, y * w * 4, (y + 1) * w * 4);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- colors ---
function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHex(rgb) {
  return '#' + rgb.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('').toUpperCase();
}

// Rotates a color's hue, keeping its saturation and lightness.
function shiftHue(hex, deg) {
  const [r, g, b] = hexToRgb(hex).map((v) => v / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (!d) return hex;
  const s = d / (1 - Math.abs(2 * l - 1));
  let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h = (((h * 60 + deg) % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r1, g1, b1] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return rgbToHex([(r1 + m) * 255, (g1 + m) * 255, (b1 + m) * 255]);
}

// --- shapes (unit coordinates, 0..1) ---
const roundRect = (cx, cy, hw, hh, r) => (x, y) => {
  const qx = Math.abs(x - cx) - (hw - r);
  const qy = Math.abs(y - cy) - (hh - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r <= 0;
};

const capsule = (ax, ay, bx, by, r) => (x, y) => {
  const pax = x - ax, pay = y - ay, bax = bx - ax, bay = by - ay;
  const t = Math.min(1, Math.max(0, (pax * bax + pay * bay) / (bax * bax + bay * bay)));
  return Math.hypot(pax - bax * t, pay - bay * t) <= r;
};

const triangle = (p1, p2, p3) => (x, y) => {
  const side = (a, b) => (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]);
  const d1 = side(p1, p2), d2 = side(p2, p3), d3 = side(p3, p1);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
};

const union = (...shapes) => (x, y) => shapes.some((s) => s(x, y));

// Upper half of a ring: the arch of a bridge.
const arch = (cx, cy, rOut, rIn) => (x, y) => {
  if (y > cy) return false;
  const d = Math.hypot(x - cx, y - cy);
  return d <= rOut && d >= rIn;
};

const solid = (hex) => {
  const c = [...hexToRgb(hex), 255];
  return () => c;
};

const diagonal = (from, to) => {
  const a = hexToRgb(from), b = hexToRgb(to);
  return (x, y) => {
    const t = Math.min(1, Math.max(0, (x + y) / 2));
    return [0, 1, 2].map((i) => a[i] + (b[i] - a[i]) * t).concat(255);
  };
};

// Each layer: { shape, paint } paints over what is below; { shape, erase: true } cuts a hole.
function render(size, layers, samples) {
  const out = Buffer.alloc(size * size * 4);
  const n = samples * samples;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const x = (px + (sx + 0.5) / samples) / size;
          const y = (py + (sy + 0.5) / samples) / size;
          let color = null;
          for (const layer of layers) {
            if (!layer.shape(x, y)) continue;
            color = layer.erase ? null : layer.paint(x, y);
          }
          if (color) {
            const alpha = color[3] / 255;
            r += color[0] * alpha; g += color[1] * alpha; b += color[2] * alpha; a += alpha;
          }
        }
      }
      const i = (py * size + px) * 4;
      if (a > 0) {
        out[i] = Math.round(r / a);
        out[i + 1] = Math.round(g / a);
        out[i + 2] = Math.round(b / a);
      }
      out[i + 3] = Math.round((a / n) * 255);
    }
  }
  return encodePNG(size, size, out);
}

const INDIGO = '#4F46E5';
const LAVENDER = '#C7D2FE';
const background = (shift) => diagonal(shiftHue('#6E72F5', shift), shiftHue('#8B4FE8', shift));

// The two arrows of the family glyph: right on top, left below.
const arrows = (y1, y2, x0, x1, r, head) =>
  union(
    capsule(x0, y1, x1 - head * 0.6, y1, r),
    triangle([x1 + head * 0.4, y1], [x1 - head * 0.6, y1 - head * 0.75], [x1 - head * 0.6, y1 + head * 0.75]),
    capsule(x0 + head * 0.6, y2, x1, y2, r),
    triangle([x0 - head * 0.4, y2], [x0 + head * 0.6, y2 - head * 0.75], [x0 + head * 0.6, y2 + head * 0.75])
  );

// Glyph styles:
//   layered - lavender back panel and tab, white front, indigo arrows
//   solid   - one white folder shape, indigo arrows
//   bridge  - one white folder shape, an indigo arch bridge
const WHITE = solid('#FFFFFF');
const BLUE = solid(INDIGO);

// Full app icon with the macOS-style margin around the rounded square.
function appIcon({ glyph, hue }) {
  const bg = { shape: roundRect(0.5, 0.5, 0.41, 0.41, 0.19), paint: background(hue) };
  if (glyph === 'layered') {
    return [
      bg,
      { shape: roundRect(0.375, 0.335, 0.105, 0.05, 0.035), paint: solid(LAVENDER) }, // tab
      { shape: roundRect(0.5, 0.45, 0.235, 0.135, 0.045), paint: solid(LAVENDER) }, // back
      { shape: roundRect(0.5, 0.585, 0.255, 0.165, 0.05), paint: WHITE }, // front
      { shape: arrows(0.545, 0.645, 0.395, 0.6, 0.024, 0.075), paint: BLUE },
    ];
  }
  const folder = union(roundRect(0.36, 0.33, 0.12, 0.06, 0.04), roundRect(0.5, 0.555, 0.27, 0.2, 0.055));
  const mark =
    glyph === 'bridge'
      ? union(capsule(0.32, 0.52, 0.68, 0.52, 0.024), arch(0.5, 0.685, 0.165, 0.128), capsule(0.353, 0.6, 0.353, 0.685, 0.0185), capsule(0.647, 0.6, 0.647, 0.685, 0.0185))
      : arrows(0.51, 0.625, 0.375, 0.625, 0.025, 0.08);
  return [bg, { shape: folder, paint: WHITE }, { shape: mark, paint: BLUE }];
}

// Small, full-bleed colored icon for the Windows tray.
function winTray({ glyph, hue }) {
  const bg = { shape: roundRect(0.5, 0.5, 0.5, 0.5, 0.22), paint: background(hue) };
  if (glyph === 'layered') {
    return [
      bg,
      { shape: roundRect(0.33, 0.22, 0.15, 0.08, 0.05), paint: solid(LAVENDER) },
      { shape: roundRect(0.5, 0.38, 0.38, 0.2, 0.07), paint: solid(LAVENDER) },
      { shape: roundRect(0.5, 0.6, 0.42, 0.28, 0.08), paint: WHITE },
      { shape: arrows(0.52, 0.7, 0.28, 0.7, 0.05, 0.14), paint: BLUE },
    ];
  }
  const folder = union(roundRect(0.3, 0.21, 0.18, 0.09, 0.06), roundRect(0.5, 0.58, 0.43, 0.33, 0.09));
  const mark =
    glyph === 'bridge'
      ? union(capsule(0.22, 0.5, 0.78, 0.5, 0.055), arch(0.5, 0.84, 0.3, 0.2))
      : arrows(0.5, 0.7, 0.27, 0.73, 0.055, 0.15);
  return [bg, { shape: folder, paint: WHITE }, { shape: mark, paint: BLUE }];
}

// macOS menu bar template: black folder, the mark cut out (only alpha matters).
function macTray({ glyph }) {
  const mark =
    glyph === 'bridge'
      ? union(capsule(0.2, 0.47, 0.8, 0.47, 0.06), arch(0.5, 0.82, 0.3, 0.19))
      : arrows(0.47, 0.67, 0.25, 0.73, 0.055, 0.15);
  return [
    { shape: roundRect(0.3, 0.2, 0.17, 0.09, 0.06), paint: solid('#000000') },
    { shape: roundRect(0.5, 0.55, 0.45, 0.33, 0.09), paint: solid('#000000') },
    { shape: mark, erase: true },
  ];
}

const root = path.join(__dirname, '..');

function write(rel, png) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, png);
  console.log('wrote', rel);
}

if (process.argv.includes('--variants')) {
  const variants = {
    v1: { glyph: 'layered', hue: -16 },
    v2: { glyph: 'solid', hue: -16 },
    v3: { glyph: 'solid', hue: -40 },
    v4: { glyph: 'bridge', hue: -16 },
    v5: { glyph: 'bridge', hue: -40 },
    v6: { glyph: 'layered', hue: -45 },
  };
  for (const [name, look] of Object.entries(variants)) {
    write(`dev/sandbox/icon-variants/${name}.png`, render(256, appIcon(look), 6));
    write(`dev/sandbox/icon-variants/${name}-tray.png`, render(32, winTray(look), 8));
    write(`dev/sandbox/icon-variants/${name}-mac.png`, render(32, macTray(look), 8));
  }
} else {
  const outputs = [
    ['build/icon.png', 1024, appIcon(ICON), 3],
    ['assets/icon.png', 256, appIcon(ICON), 6],
    ['assets/icon-128.png', 128, appIcon(ICON), 8],
    ['assets/tray.png', 16, winTray(ICON), 8],
    ['assets/tray@2x.png', 32, winTray(ICON), 8],
    ['assets/trayTemplate.png', 16, macTray(ICON), 8],
    ['assets/trayTemplate@2x.png', 32, macTray(ICON), 8],
  ];
  for (const [rel, size, layers, samples] of outputs) write(rel, render(size, layers, samples));
}
