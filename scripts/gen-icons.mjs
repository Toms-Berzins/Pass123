/* global Buffer, console */
/**
 * Generates Pass123 action icons (16/48/128 px) as PNGs into public/icons/,
 * using only Node built-ins — no image dependencies.
 *
 * Design: a rounded-square in the brand signal-green gradient with a dark keyhole
 * (matches the Hi-Fi lock badge — green tile, near-black glyph).
 * Run: node scripts/gen-icons.mjs
 */
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = resolve(__dirname, '..', 'public', 'icons')

// Dark glass background; signal-green key glyph.
const BG_A = [9, 9, 15]       // #09090f near-black
const BG_B = [19, 19, 30]     // #13131e dark glass
const GLYPH = [57, 255, 110]  // #39ff6e signal green
const SS = 4 // supersampling factor for smooth edges

const lerp = (a, b, t) => a + (b - a) * t
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi)

/**
 * Returns true if (fx,fy) is inside the key glyph.
 * Key: horizontal — ring bow on left, shaft right, 3 teeth (1:2:3 heights) downward.
 */
function isKey(fx, fy, N) {
  const bowX = N * 0.27, bowY = N * 0.47
  const bowOuter = N * 0.155, bowInner = N * 0.078

  // Bow ring
  const d = Math.hypot(fx - bowX, fy - bowY)
  if (d <= bowOuter && d > bowInner) return true

  // Shaft
  const shaftL = bowX, shaftR = N * 0.82
  const shaftT = N * 0.435, shaftB = N * 0.515
  if (fx >= shaftL && fx <= shaftR && fy >= shaftT && fy <= shaftB) return true

  // Three teeth below shaft — strict 1:2:3 height ratio
  const u = N * 0.065  // one tooth unit
  const tw = N * 0.07  // tooth width
  const t1x = N * 0.545
  const t2x = t1x + tw + N * 0.03
  const t3x = t2x + tw + N * 0.03
  if (fx >= t1x && fx <= t1x + tw && fy > shaftB && fy <= shaftB + u)       return true
  if (fx >= t2x && fx <= t2x + tw && fy > shaftB && fy <= shaftB + u * 2)   return true
  if (fx >= t3x && fx <= t3x + tw && fy > shaftB && fy <= shaftB + u * 3)   return true

  return false
}

/** Color + coverage at a floating-point sample. Returns [r,g,b,a]. */
function sample(fx, fy, N) {
  const r = N * 0.22
  const cx = clamp(fx, r, N - r)
  const cy = clamp(fy, r, N - r)
  const inside = Math.hypot(fx - cx, fy - cy) <= r
  if (!inside) return [0, 0, 0, 0]

  // Dark glass background — diagonal gradient
  const t = (fx + fy) / (2 * N)
  let col = [
    lerp(BG_A[0], BG_B[0], t),
    lerp(BG_A[1], BG_B[1], t),
    lerp(BG_A[2], BG_B[2], t),
  ]

  // Specular highlight — faint white band across top-left (matches mark-glyph style)
  const specT = clamp(0.07 - ((fx * 0.55 + fy * 0.45) / N) * 0.22, 0, 1)
  col = col.map(c => Math.min(255, c + Math.round(255 * specT)))

  // Key glyph in signal-green
  if (isKey(fx, fy, N)) col = [...GLYPH]

  return [col[0], col[1], col[2], 255]
}

function renderRGBA(N) {
  const buf = new Uint8Array(N * N * 4)
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      let r = 0, g = 0, b = 0, a = 0
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const [sr, sg, sb, sa] = sample(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS, N)
          // Premultiply so transparent samples don't pollute color.
          r += sr * sa
          g += sg * sa
          b += sb * sa
          a += sa
        }
      }
      const n = SS * SS
      const i = (y * N + x) * 4
      const alpha = a / n
      buf[i] = alpha > 0 ? Math.round(r / a) : 0
      buf[i + 1] = alpha > 0 ? Math.round(g / a) : 0
      buf[i + 2] = alpha > 0 ? Math.round(b / a) : 0
      buf[i + 3] = Math.round(alpha)
    }
  }
  return buf
}

// --- Minimal PNG encoder ---
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(bytes) {
  let c = 0xffffffff
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typeBytes = Buffer.from(type, 'ascii')
  const body = Buffer.concat([typeBytes, data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([len, body, crc])
}

function encodePNG(N, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(N, 0)
  ihdr.writeUInt32BE(N, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type RGBA
  // 10,11,12 = compression/filter/interlace = 0

  // Raw image data: each scanline prefixed with filter byte 0.
  const raw = Buffer.alloc(N * (N * 4 + 1))
  for (let y = 0; y < N; y++) {
    raw[y * (N * 4 + 1)] = 0
    rgba.subarray(y * N * 4, (y + 1) * N * 4).forEach((v, i) => {
      raw[y * (N * 4 + 1) + 1 + i] = v
    })
  }
  const idat = deflateSync(raw)

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

mkdirSync(OUT_DIR, { recursive: true })
for (const N of [16, 48, 128]) {
  const png = encodePNG(N, renderRGBA(N))
  const file = resolve(OUT_DIR, `icon${N}.png`)
  writeFileSync(file, png)
  console.log(`wrote ${file} (${png.length} bytes)`)
}
