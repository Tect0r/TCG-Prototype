/**
 * Generates the default card image plus a couple of sample card arts, so the
 * artwork pipeline can be seen working without shipping real art.
 *
 * Writes 768x1024 PNGs (the documented standard, CLAUDE.md §6) using only the
 * Node standard library — no image dependency for a handful of placeholders.
 *
 *   npm run gen:placeholder-art
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const WIDTH = 768;
const HEIGHT = 1024;

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([length, typeAndData, crc]);
}

/** @param {(x: number, y: number) => [number, number, number]} shade */
function encodePng(shade) {
  const stride = WIDTH * 3 + 1;
  const raw = Buffer.alloc(stride * HEIGHT);
  for (let y = 0; y < HEIGHT; y += 1) {
    const rowStart = y * stride;
    raw[rowStart] = 0; // filter: none
    for (let x = 0; x < WIDTH; x += 1) {
      const [r, g, b] = shade(x, y);
      const i = rowStart + 1 + x * 3;
      raw[i] = r;
      raw[i + 1] = g;
      raw[i + 2] = b;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(WIDTH, 0);
  ihdr.writeUInt32BE(HEIGHT, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const mix = (a, b, t) => a.map((channel, i) => Math.round(channel + (b[i] - channel) * t));

/**
 * Vertical gradient with a soft inset border and faint diagonal hatching, so a
 * placeholder is obviously a placeholder at a glance.
 */
function placeholder(top, bottom) {
  const border = [24, 24, 28];
  return (x, y) => {
    const inset = Math.min(x, y, WIDTH - 1 - x, HEIGHT - 1 - y);
    if (inset < 12) return border;

    const base = mix(top, bottom, y / (HEIGHT - 1));
    const hatch = (x + y) % 96 < 3 ? 0.08 : 0;
    const vignette = inset < 40 ? (40 - inset) / 40 : 0;
    return mix(base, border, hatch + vignette * 0.25);
  };
}

const targets = [
  {
    path: join('assets', 'defaults', 'default_card.png'),
    shade: placeholder([104, 100, 94], [58, 56, 54]),
  },
  {
    path: join('assets', 'card-art', 'goblin_scout.png'),
    shade: placeholder([176, 88, 62], [86, 38, 32]),
  },
  {
    path: join('assets', 'card-art', 'bramble_titan.png'),
    shade: placeholder([84, 132, 90], [30, 58, 40]),
  },
  {
    path: join('assets', 'card-art', 'prototype_commander_blue_red.png'),
    shade: placeholder([70, 116, 176], [128, 62, 74]),
  },
];

for (const target of targets) {
  const absolute = join(repoRoot, target.path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, encodePng(target.shade));
  console.warn(`wrote ${target.path}`);
}
