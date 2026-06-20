/**
 * Generates Pass123 action icons (16/48/128 px) as PNGs into public/icons/,
 * using only Node built-ins — no image dependencies.
 *
 * Design: a rounded-square in the brand accent gradient with a white keyhole.
 * Run: node scripts/gen-icons.mjs
 */
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = resolve(__dirname, '..', 'public', 'icons')

const ACCENT_A = [108, 140, 255] // #6c8cff
const ACCENT_B = [90, 120, 230] // #5a78e6
const WHITE = [255, 255, 255]
const SS = 4 // supersampling factor for smooth edges

const lerp = (a, b, t) => a + (b - a) * t
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi)

/** Color + coverage at a floating-point sample. Returns [r,g,b,a]. */
function sample(fx, fy, N) {
  const r = N * 0.22 // corner radius
  // Rounded-rect SDF: inside if distance to the inset rect corner box <= r.
  const cx = clamp(fx, r, N - r)
  const cy = clamp(fy, r, N - r)
  const inside = Math.hypot(fx - cx, fy - cy) <= r
  if (!inside) return [0, 0, 0, 0]

  // Background gradient (diagonal).
  const t = (fx + fy) / (2 * N)
  let col = [
    lerp(ACCENT_A[0], ACCENT_B[0], t),
    lerp(ACCENT_A[1], ACCENT_B[1], t),
    lerp(ACCENT_A[2], ACCENT_B[2], t),
  ]

  // Keyhole: circle head + tapering stem.
  const kx = N * 0.5
  const ky = N * 0.4
  const kr = N * 0.15
  const inCircle = Math.hypot(fx - kx, fy - ky) <= kr
  const stemTop = ky
  const stemBot = N * 0.7
  let inStem = false
  if (fy >= stemTop && fy <= stemBot) {
    const hw = lerp(N * 0.045, N * 0.085, (fy - stemTop) / (stemBot - stemTop))
    inStem = Math.abs(fx - kx) <= hw
  }
  if (inCircle || inStem) col = [...WHITE]

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
