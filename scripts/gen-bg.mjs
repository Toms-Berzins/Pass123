// Generate a 1280x800 brand background canvas for Chrome Web Store screenshots.
// Cyber-industrial dark-green theme: vertical gradient + soft accent glow behind
// where the popup gets composited + subtle edge vignette. Zero deps — raw PNG via
// Node's built-in zlib. Output goes to the gitignored screenshots/ folder.
//
//   node scripts/gen-bg.mjs            -> screenshots/bg.png (1280x800)
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const W = 1280
const H = 800

// Palette (cyber-industrial green).
const TOP = [0x0c, 0x16, 0x11] // gradient top
const BOTTOM = [0x06, 0x0c, 0x09] // gradient bottom
const ACCENT = [0x35, 0xe0, 0x9b] // glow tint

const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v))
const lerp = (a, b, t) => a + (b - a) * t

// Glow centered slightly above middle, behind the composited popup.
const gx = W * 0.5
const gy = H * 0.42
const gRadius = 560

// Raw image: one filter byte (0 = none) per row, then RGB triples.
const stride = 1 + W * 3
const raw = Buffer.alloc(H * stride)

for (let y = 0; y < H; y++) {
  raw[y * stride] = 0 // filter: none
  const vt = y / (H - 1)
  for (let x = 0; x < W; x++) {
    let r = lerp(TOP[0], BOTTOM[0], vt)
    let g = lerp(TOP[1], BOTTOM[1], vt)
    let b = lerp(TOP[2], BOTTOM[2], vt)

    // Soft radial accent glow (smooth falloff).
    const dx = x - gx
    const dy = y - gy
    const d = Math.sqrt(dx * dx + dy * dy)
    const glow = Math.max(0, 1 - d / gRadius) ** 2.2 * 0.16
    r += (ACCENT[0] - r) * glow
    g += (ACCENT[1] - g) * glow
    b += (ACCENT[2] - b) * glow

    // Edge vignette (darken toward corners).
    const nx = (x / W - 0.5) * 2
    const ny = (y / H - 0.5) * 2
    const vig = 1 - Math.min(1, (nx * nx + ny * ny) * 0.18)
    r *= vig
    g *= vig
    b *= vig

    const o = y * stride + 1 + x * 3
    raw[o] = clamp(r)
    raw[o + 1] = clamp(g)
    raw[o + 2] = clamp(b)
  }
}

// --- minimal PNG encoder ---
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
const crc32 = (buf) => {
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}
const chunk = (type, data) => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const body = Buffer.concat([typeBuf, data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([len, body, crc])
}

const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(W, 0)
ihdr.writeUInt32BE(H, 4)
ihdr[8] = 8 // bit depth
ihdr[9] = 2 // color type: truecolor RGB
ihdr[10] = 0 // compression
ihdr[11] = 0 // filter
ihdr[12] = 0 // interlace

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
])

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = resolve(root, 'screenshots')
mkdirSync(outDir, { recursive: true })
const out = resolve(outDir, 'bg.png')
writeFileSync(out, png)
console.log(`Wrote ${out} (${W}x${H}, ${(png.length / 1024).toFixed(1)} KB)`)
