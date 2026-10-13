/**
 * Generates JIVA's SYNTHETIC sample documents (data/catalogue/assets/) and records each file's size and
 * sha256 in data/catalogue/scan-assets.json.
 *
 *   npm run catalogue:assets
 *
 * Everything here is drawn procedurally from simple shapes and a seeded random generator: no image comes
 * from a person, a dataset or the internet. Every file carries a visible "synthetic sample — not a real
 * patient" label, shows no finding, and is not suitable for diagnosis or training. The output is
 * deterministic, so re-running it produces byte-identical files (and unchanged hashes).
 */
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { createHash } from 'crypto';

const ROOT = path.resolve(__dirname, '..');
const ASSET_DIR = path.join(ROOT, 'data/catalogue/assets');
const CATALOGUE = path.join(ROOT, 'data/catalogue/scan-assets.json');

// ------------------------------------------------------------------ PNG encoding

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** 8-bit grayscale (channels = 1) or RGB (channels = 3) PNG. */
function encodePng(width: number, height: number, channels: 1 | 3, pixels: Uint8Array): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = channels === 1 ? 0 : 2;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    Buffer.from(pixels.buffer, pixels.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ------------------------------------------------------------------ drawing

/** Seeded PRNG (mulberry32): the same seed always gives the same image. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (v: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));

/** A grayscale canvas with values 0 (black) … 1 (white). */
class Gray {
  readonly data: Float32Array;
  constructor(readonly w: number, readonly h: number, fill = 0) {
    this.data = new Float32Array(w * h).fill(fill);
  }

  blend(x: number, y: number, v: number, a: number) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h || a <= 0) return;
    const i = y * this.w + x;
    this.data[i] = this.data[i] * (1 - a) + v * a;
  }

  /** Filled ellipse with a soft edge of `soft` pixels, blended at `opacity`. */
  ellipse(cx: number, cy: number, rx: number, ry: number, v: number, soft = 2, opacity = 1) {
    const x0 = Math.floor(cx - rx - soft), x1 = Math.ceil(cx + rx + soft);
    const y0 = Math.floor(cy - ry - soft), y1 = Math.ceil(cy + ry + soft);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const d = Math.sqrt(((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2);
        const edge = (1 - d) * Math.min(rx, ry);
        const a = clamp(edge / soft + 0.5);
        this.blend(x, y, v, a * opacity);
      }
    }
  }

  /** A thick line made of soft discs. */
  line(xa: number, ya: number, xb: number, yb: number, thickness: number, v: number, opacity = 1) {
    const steps = Math.ceil(Math.hypot(xb - xa, yb - ya));
    for (let s = 0; s <= steps; s++) {
      const t = steps ? s / steps : 0;
      this.disc(xa + (xb - xa) * t, ya + (yb - ya) * t, thickness / 2, v, opacity);
    }
  }

  disc(cx: number, cy: number, r: number, v: number, opacity = 1) {
    for (let y = Math.floor(cy - r - 1); y <= Math.ceil(cy + r + 1); y++) {
      for (let x = Math.floor(cx - r - 1); x <= Math.ceil(cx + r + 1); x++) {
        const a = clamp(r - Math.hypot(x - cx, y - cy) + 0.5);
        if (a > 0) this.blend(x, y, v, a * opacity);
      }
    }
  }

  /** Separable box blur, applied twice (close to a gaussian). */
  blur(radius: number) {
    for (let pass = 0; pass < 2; pass++) {
      for (const horizontal of [true, false]) {
        const out = new Float32Array(this.data.length);
        const n = horizontal ? this.w : this.h;
        const lines = horizontal ? this.h : this.w;
        for (let l = 0; l < lines; l++) {
          let sum = 0;
          const at = (k: number) => this.data[horizontal ? l * this.w + clampInt(k, 0, n - 1) : clampInt(k, 0, n - 1) * this.w + l];
          for (let k = -radius; k <= radius; k++) sum += at(k);
          for (let k = 0; k < n; k++) {
            out[horizontal ? l * this.w + k : k * this.w + l] = sum / (2 * radius + 1);
            sum += at(k + radius + 1) - at(k - radius);
          }
        }
        this.data.set(out);
      }
    }
  }

  noise(amount: number, rnd: () => number) {
    for (let i = 0; i < this.data.length; i++) this.data[i] += (rnd() - 0.5) * 2 * amount;
  }

  text(x: number, y: number, str: string, scale: number, v: number) {
    drawText(str, x, y, scale, (px, py) => {
      for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) this.blend(px + dx, py + dy, v, 1);
    });
  }

  /** A dark band behind a label, so the label stays legible on any background. */
  band(y: number, height: number, v = 0, opacity = 0.75) {
    for (let yy = y; yy < y + height; yy++) for (let x = 0; x < this.w; x++) this.blend(x, yy, v, opacity);
  }

  png(): Buffer {
    const px = new Uint8Array(this.w * this.h);
    for (let i = 0; i < px.length; i++) px[i] = Math.round(clamp(this.data[i]) * 255);
    return encodePng(this.w, this.h, 1, px);
  }
}

const clampInt = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

// 5×7 bitmap font: enough for the labels (upper case, digits, a little punctuation).
const FONT: Record<string, string[]> = {
  A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  B: ['####.', '#...#', '#...#', '####.', '#...#', '#...#', '####.'],
  C: ['.###.', '#...#', '#....', '#....', '#....', '#...#', '.###.'],
  D: ['####.', '#...#', '#...#', '#...#', '#...#', '#...#', '####.'],
  E: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
  F: ['#####', '#....', '#....', '####.', '#....', '#....', '#....'],
  G: ['.###.', '#...#', '#....', '#.###', '#...#', '#...#', '.###.'],
  H: ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  I: ['.###.', '..#..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  J: ['..###', '...#.', '...#.', '...#.', '...#.', '#..#.', '.##..'],
  K: ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'],
  L: ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
  M: ['#...#', '##.##', '#.#.#', '#.#.#', '#...#', '#...#', '#...#'],
  N: ['#...#', '#...#', '##..#', '#.#.#', '#..##', '#...#', '#...#'],
  O: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  P: ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
  Q: ['.###.', '#...#', '#...#', '#...#', '#.#.#', '#..#.', '.##.#'],
  R: ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
  S: ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'],
  T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  U: ['#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  V: ['#...#', '#...#', '#...#', '#...#', '#...#', '.#.#.', '..#..'],
  W: ['#...#', '#...#', '#...#', '#.#.#', '#.#.#', '#.#.#', '.#.#.'],
  X: ['#...#', '#...#', '.#.#.', '..#..', '.#.#.', '#...#', '#...#'],
  Y: ['#...#', '#...#', '.#.#.', '..#..', '..#..', '..#..', '..#..'],
  Z: ['#####', '....#', '...#.', '..#..', '.#...', '#....', '#####'],
  0: ['.###.', '#...#', '#..##', '#.#.#', '##..#', '#...#', '.###.'],
  1: ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  2: ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'],
  3: ['#####', '...#.', '..#..', '...#.', '....#', '#...#', '.###.'],
  4: ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'],
  5: ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
  6: ['..##.', '.#...', '#....', '####.', '#...#', '#...#', '.###.'],
  7: ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...'],
  8: ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'],
  9: ['.###.', '#...#', '#...#', '.####', '....#', '...#.', '.##..'],
  ' ': ['.....', '.....', '.....', '.....', '.....', '.....', '.....'],
  '-': ['.....', '.....', '.....', '#####', '.....', '.....', '.....'],
  '(': ['...#.', '..#..', '.#...', '.#...', '.#...', '..#..', '...#.'],
  ')': ['.#...', '..#..', '...#.', '...#.', '...#.', '..#..', '.#...'],
  '.': ['.....', '.....', '.....', '.....', '.....', '.##..', '.##..'],
  ',': ['.....', '.....', '.....', '.....', '.##..', '..#..', '.#...'],
  ':': ['.....', '.##..', '.##..', '.....', '.##..', '.##..', '.....'],
  '/': ['.....', '....#', '...#.', '..#..', '.#...', '#....', '.....'],
  '%': ['##...', '##..#', '...#.', '..#..', '.#...', '#..##', '...##'],
  '+': ['.....', '..#..', '..#..', '#####', '..#..', '..#..', '.....'],
};

function drawText(str: string, x: number, y: number, scale: number, plot: (px: number, py: number) => void) {
  let cx = x;
  for (const ch of str.toUpperCase()) {
    const glyph = FONT[ch];
    if (!glyph) throw new Error(`No glyph for ${JSON.stringify(ch)}`);
    for (let row = 0; row < 7; row++) {
      for (let col = 0; col < 5; col++) if (glyph[row][col] === '#') plot(cx + col * scale, y + row * scale);
    }
    cx += 6 * scale;
  }
}

const WATERMARK = 'SYNTHETIC SAMPLE - NOT A REAL PATIENT';
const NOT_DIAGNOSTIC = 'NO FINDING IMPLIED - NOT FOR DIAGNOSIS';

/** Title at the top, the synthetic notice at the bottom, on dark bands. */
function labelGray(c: Gray, title: string) {
  c.band(0, 34);
  c.text(12, 10, title, 2, 0.95);
  c.band(c.h - 52, 52);
  c.text(12, c.h - 44, WATERMARK, 2, 0.95);
  c.text(12, c.h - 22, NOT_DIAGNOSTIC, 2, 0.8);
}

// ------------------------------------------------------------------ images

function chestXray(): Buffer {
  const c = new Gray(512, 512, 0.05);
  const rnd = prng(101);
  c.ellipse(256, 300, 205, 255, 0.3, 24);
  c.ellipse(168, 268, 80, 150, 0.11, 14);
  c.ellipse(344, 268, 80, 150, 0.11, 14);
  c.ellipse(282, 338, 70, 60, 0.42, 10, 0.9);
  c.ellipse(256, 300, 17, 235, 0.5, 4, 0.85);
  for (let i = 0; i < 9; i++) {
    const y0 = 150 + i * 30;
    for (const side of [-1, 1]) {
      let px = 256 + side * 20, py = y0;
      for (let dx = 0; dx <= 170; dx += 5) {
        const x = 256 + side * (20 + dx);
        const y = y0 + ((dx / 170) ** 2) * 55;
        c.line(px, py, x, y, 5, 0.4, 0.55);
        px = x;
        py = y;
      }
    }
  }
  c.line(238, 140, 118, 118, 9, 0.5, 0.8);
  c.line(274, 140, 394, 118, 9, 0.5, 0.8);
  c.blur(2);
  c.noise(0.025, rnd);
  c.text(30, 60, 'R', 3, 0.9);
  labelGray(c, 'SYNTHETIC CHEST X-RAY (PA)');
  return c.png();
}

function legXray(): Buffer {
  const c = new Gray(512, 512, 0.05);
  const rnd = prng(202);
  c.ellipse(256, 270, 92, 300, 0.24, 20);
  for (let y = 70; y <= 440; y++) {
    for (let x = 213; x <= 259; x++) c.blend(x, y, x > 228 && x < 244 ? 0.45 : 0.63, 0.95);
    for (let x = 293; x <= 309; x++) c.blend(x, y, 0.55, 0.9);
  }
  c.ellipse(238, 64, 64, 30, 0.6, 6);
  c.ellipse(246, 452, 52, 24, 0.6, 6);
  c.blur(2);
  c.noise(0.02, rnd);
  c.text(30, 60, 'L', 3, 0.9);
  labelGray(c, 'SYNTHETIC LEG X-RAY (LATERAL)');
  return c.png();
}

function ctHead(): Buffer {
  const c = new Gray(512, 512, 0);
  const rnd = prng(303);
  c.ellipse(256, 262, 186, 214, 0.95, 3);
  c.ellipse(256, 262, 170, 198, 0.42, 3);
  c.ellipse(256, 262, 128, 158, 0.47, 18, 0.8);
  c.ellipse(232, 246, 13, 44, 0.12, 5);
  c.ellipse(280, 246, 13, 44, 0.12, 5);
  c.ellipse(256, 300, 5, 14, 0.15, 3);
  c.noise(0.03, rnd);
  c.blur(1);
  labelGray(c, 'SYNTHETIC CT HEAD (AXIAL)');
  return c.png();
}

function mriBrain(): Buffer {
  const c = new Gray(512, 512, 0.02);
  const rnd = prng(404);
  c.ellipse(262, 252, 196, 206, 0.55, 6);
  c.ellipse(262, 252, 184, 194, 0.1, 4);
  c.ellipse(268, 232, 168, 160, 0.48, 6);
  c.ellipse(336, 358, 70, 48, 0.53, 6);
  c.ellipse(296, 390, 22, 72, 0.5, 5);
  for (let a = 200; a <= 340; a += 2) {
    const r = (a * Math.PI) / 180;
    c.disc(262 + Math.cos(r) * 92, 262 + Math.sin(r) * 34, 6, 0.78, 0.8);
  }
  c.ellipse(262, 248, 58, 16, 0.14, 4);
  c.noise(0.025, rnd);
  c.blur(1);
  labelGray(c, 'SYNTHETIC MRI BRAIN (SAGITTAL)');
  return c.png();
}

function ultrasound(): Buffer {
  const c = new Gray(512, 512, 0);
  const rnd = prng(505);
  const apex = { x: 256, y: 40 };
  const half = (38 * Math.PI) / 180;
  for (let y = 0; y < 512; y++) {
    for (let x = 0; x < 512; x++) {
      const dx = x - apex.x, dy = y - apex.y;
      const r = Math.hypot(dx, dy);
      const th = Math.atan2(dx, dy);
      if (dy > 0 && r > 50 && r < 440 && Math.abs(th) < half) {
        const depthFade = 1 - (r - 50) / 600;
        c.data[y * 512 + x] = (0.18 + rnd() * 0.32) * depthFade;
      }
    }
  }
  c.blur(1);
  for (let a = -30; a <= 30; a += 1) {
    const t = (a * Math.PI) / 180;
    c.disc(apex.x + Math.sin(t) * 210, apex.y + Math.cos(t) * 210, 3, 0.75, 0.7);
  }
  c.ellipse(300, 330, 78, 44, 0.2, 10, 0.8);
  for (let a = 0; a < 360; a += 3) {
    const t = (a * Math.PI) / 180;
    c.disc(300 + Math.cos(t) * 78, 330 + Math.sin(t) * 44, 2.5, 0.7, 0.6);
  }
  for (let cm = 1; cm <= 3; cm++) {
    const y = apex.y + 50 + cm * 120;
    c.line(470, y, 484, y, 2, 0.9);
    c.text(456, y - 20, String(cm * 5), 2, 0.9);
  }
  labelGray(c, 'SYNTHETIC ULTRASOUND (ABDOMEN)');
  return c.png();
}

function ecgStrip(): Buffer {
  const w = 1000, h = 300;
  const px = new Uint8Array(w * h * 3);
  const set = (x: number, y: number, r: number, g: number, b: number) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const i = (y * w + x) * 3;
    px[i] = r;
    px[i + 1] = g;
    px[i + 2] = b;
  };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) set(x, y, 255, 246, 246);
  for (let x = 0; x < w; x += 8) for (let y = 0; y < h; y++) set(x, y, 250, 205, 205);
  for (let y = 0; y < h; y += 8) for (let x = 0; x < w; x++) set(x, y, 250, 205, 205);
  for (let x = 0; x < w; x += 40) for (let y = 0; y < h; y++) set(x, y, 236, 140, 140);
  for (let y = 0; y < h; y += 40) for (let x = 0; x < w; x++) set(x, y, 236, 140, 140);
  // 25 mm/s and 10 mm/mV with 1 mm = 8 px: 200 px per second, 80 px per millivolt. 75 beats per minute.
  const g = (t: number, mu: number, s: number) => Math.exp(-(((t - mu) / s) ** 2) / 2);
  const mv = (t: number) => {
    const b = t % 0.8;
    return 0.15 * g(b, 0.16, 0.025) - 0.1 * g(b, 0.235, 0.008) + 1.2 * g(b, 0.25, 0.01) - 0.25 * g(b, 0.265, 0.009) + 0.3 * g(b, 0.45, 0.04);
  };
  const base = 180;
  let prevY = base - mv(0) * 80;
  for (let x = 1; x < w; x++) {
    const y = base - mv(x / 200) * 80;
    const lo = Math.round(Math.min(prevY, y)), hi = Math.round(Math.max(prevY, y));
    for (let yy = lo; yy <= hi; yy++) for (let t = -1; t <= 1; t++) set(x, yy + t, 20, 20, 20);
    prevY = y;
  }
  const label = (x: number, y: number, s: string, scale: number) =>
    drawText(s, x, y, scale, (qx, qy) => {
      for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) set(qx + dx, qy + dy, 140, 20, 20);
    });
  label(12, 12, 'SYNTHETIC ECG RHYTHM STRIP - LEAD II - 25 MM/S - 10 MM/MV', 2);
  label(12, h - 50, WATERMARK, 2);
  label(12, h - 26, NOT_DIAGNOSTIC, 2);
  return encodePng(w, h, 3, px);
}

// ------------------------------------------------------------------ PDF (laboratory report samples)

const pdfText = (s: string) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

function labReportPdf(title: string, rows: Array<[string, string, string, string]>): Buffer {
  const ops: string[] = [];
  const text = (x: number, y: number, size: number, s: string, bold = false) => ops.push(`BT /${bold ? 'F2' : 'F1'} ${size} Tf ${x} ${y} Td (${pdfText(s)}) Tj ET`);
  ops.push('0.75 0.12 0.12 rg 40 770 515 44 re f');
  ops.push('1 1 1 rg');
  text(52, 796, 12, 'SYNTHETIC SAMPLE - NOT A REAL PATIENT - NOT FOR DIAGNOSIS', true);
  text(52, 780, 9, 'Generated for software demonstration by JIVA. The values are illustrative, not a result.');
  ops.push('0 0 0 rg');
  text(40, 735, 18, title, true);
  text(40, 712, 10, 'Laboratory: JIVA Synthetic Laboratory (fictional)');
  text(40, 698, 10, 'Patient: synthetic sample - no real person');
  text(40, 684, 10, 'Specimen: illustrative');
  ops.push('0.85 0.85 0.85 rg 40 650 515 22 re f 0 0 0 rg');
  const cols = [48, 260, 350, 440];
  ['Test', 'Result', 'Units', 'Reference range'].forEach((h, i) => text(cols[i], 657, 10, h, true));
  rows.forEach((r, n) => {
    const y = 630 - n * 20;
    r.forEach((cell, i) => text(cols[i], y, 10, cell));
  });
  const end = 630 - rows.length * 20 - 20;
  text(40, end, 9, 'Reference ranges differ between laboratories. JIVA does not interpret results.');
  const stream = ops.join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>',
    `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`,
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const cbc = () => labReportPdf('Complete blood count (synthetic sample)', [
  ['Haemoglobin', '13.8', 'g/dL', '13.0 - 17.0'],
  ['White cell count', '7.2', 'x10^9/L', '4.0 - 11.0'],
  ['Platelets', '245', 'x10^9/L', '150 - 410'],
  ['Haematocrit', '41', '%', '40 - 50'],
  ['Mean cell volume', '89', 'fL', '83 - 101'],
]);

const metabolic = () => labReportPdf('Basic metabolic panel (synthetic sample)', [
  ['Sodium', '139', 'mmol/L', '135 - 145'],
  ['Potassium', '4.2', 'mmol/L', '3.5 - 5.1'],
  ['Chloride', '103', 'mmol/L', '98 - 107'],
  ['Bicarbonate', '25', 'mmol/L', '22 - 29'],
  ['Urea', '5.1', 'mmol/L', '2.5 - 7.8'],
  ['Creatinine', '84', 'umol/L', '59 - 104'],
  ['Glucose (random)', '5.6', 'mmol/L', '3.9 - 7.8'],
]);

// ------------------------------------------------------------------ main

const GENERATORS: Record<string, () => Buffer> = {
  'synthetic-chest-xray-pa.png': chestXray,
  'synthetic-leg-xray-lateral.png': legXray,
  'synthetic-ct-head-axial.png': ctHead,
  'synthetic-mri-brain-sagittal.png': mriBrain,
  'synthetic-ultrasound-abdomen.png': ultrasound,
  'synthetic-ecg-lead-ii.png': ecgStrip,
  'synthetic-lab-cbc.pdf': cbc,
  'synthetic-lab-metabolic-panel.pdf': metabolic,
};

function main() {
  fs.mkdirSync(ASSET_DIR, { recursive: true });
  const catalogue = JSON.parse(fs.readFileSync(CATALOGUE, 'utf8')) as { entries: Array<{ assetId: string; assetRef: string; sizeBytes: number; sha256: string }> };
  const written = new Map<string, { size: number; sha256: string }>();
  for (const [name, make] of Object.entries(GENERATORS)) {
    const bytes = make();
    fs.writeFileSync(path.join(ASSET_DIR, name), bytes);
    written.set(name, { size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    console.log(`  ${name}  ${bytes.length} bytes`);
  }
  for (const e of catalogue.entries) {
    const w = written.get(e.assetRef);
    if (!w) throw new Error(`${e.assetId}: no generator for ${e.assetRef}`);
    e.sizeBytes = w.size;
    e.sha256 = w.sha256;
  }
  fs.writeFileSync(CATALOGUE, JSON.stringify(catalogue, null, 2) + '\n');
  console.log(`Updated sizes and hashes of ${catalogue.entries.length} entries in ${path.relative(ROOT, CATALOGUE)}.`);
}

main();
