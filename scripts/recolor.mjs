/* global Buffer, process, console */
/**
 * Color-corrects the Nano Banana brand PNGs toward the Pass123 signal-green
 * (#39ff6e). Greenish, saturated pixels are rotated to the brand hue and
 * saturated up; near-grayscale pixels (the dark padlock glyph, black background,
 * white highlights) are left alone. Pure Node built-ins — no image deps.
 *
 * Run: node scripts/recolor.mjs            (recolor all brand/*.png in place)
 *      node scripts/recolor.mjs logo promo (only those)
 * Also writes brand/store-icon-128.png (downscaled from the corrected logo).
 */
import { deflateSync, inflateSync } from 'node:zlib'
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { dirname, resolve, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Buffer } from 'node:buffer'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DIR = resolve(__dirname, '..', 'brand')

// Brand target: #39ff6e → HSL hue ≈ 136°.
const TARGET_HUE = 136 / 360

// ── Minimal PNG decoder (8-bit, color type 2/6, non-interlaced) ────────────
function decodePNG(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG')
  let off = 8
  let width = 0, height = 0, colorType = 0, bitDepth = 0
  const idat = []
  while (off < buf.length) {
    const len = buf.readUInt32BE(off)
    const type = buf.toString('ascii', off + 4, off + 8)
    const data = buf.subarray(off + 8, off + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
      if (bitDepth !== 8) throw new Error(`unsupported bit depth ${bitDepth}`)
      if (data[12] !== 0) throw new Error('interlaced PNG unsupported')
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data))
    } else if (type === 'IEND') {
      break
    }
    off += 12 + len
  }
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0
  if (!channels) throw new Error(`unsupported color type ${colorType}`)

  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const out = Buffer.alloc(stride * height)
  const paeth = (a, b, c) => {
    const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
  }
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const rowIn = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride)
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? out[y * stride + i - channels] : 0
      const b = y > 0 ? out[(y - 1) * stride + i] : 0
      const c = y > 0 && i >= channels ? out[(y - 1) * stride + i - channels] : 0
      let v = rowIn[i]
      if (filter === 1) v += a
      else if (filter === 2) v += b
      else if (filter === 3) v += (a + b) >> 1
      else if (filter === 4) v += paeth(a, b, c)
      out[y * stride + i] = v & 0xff
    }
  }
  return { width, height, channels, data: out }
}

// ── PNG encoder (always RGBA / color type 6) ───────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
const crc32 = (bytes) => {
  let c = 0xffffffff
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([len, body, crc])
}
function encodePNG(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8; ihdr[9] = 6
  const raw = Buffer.alloc(height * (width * 4 + 1))
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0
    rgba.subarray(y * width * 4, (y + 1) * width * 4).copy(raw, y * (width * 4 + 1) + 1)
  }
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))])
}

// ── Color space ────────────────────────────────────────────────────────────
function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min
  let h = 0
  const l = (max + min) / 2
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1))
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6
    else if (max === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
    h /= 6
    if (h < 0) h += 1
  }
  return [h, s, l]
}
function hslToRgb(h, s, l) {
  if (s === 0) { const v = Math.round(l * 255); return [v, v, v] }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const hue = (t) => {
    if (t < 0) t += 1; if (t > 1) t -= 1
    if (t < 1 / 6) return p + (q - p) * 6 * t
    if (t < 1 / 2) return q
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
    return p
  }
  return [Math.round(hue(h + 1 / 3) * 255), Math.round(hue(h) * 255), Math.round(hue(h - 1 / 3) * 255)]
}

/** Push greenish/saturated pixels to the brand hue; leave neutrals untouched. */
function recolor({ width, height, channels, data }) {
  const out = Buffer.alloc(width * height * 4)
  for (let i = 0, j = 0; j < width * height * 4; i += channels, j += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2]
    const a = channels === 4 ? data[i + 3] : 255
    const [h, s, l] = rgbToHsl(r, g, b)
    const hueDeg = h * 360
    const greenish = hueDeg > 55 && hueDeg < 185 && s > 0.1 && l > 0.05 && l < 0.97
    let nr = r, ng = g, nb = b
    if (greenish) {
      const ns = Math.min(1, Math.max(s, 0.9))
      // Gentle lift for the mid-tone fill so the badge reads as vivid #39ff6e.
      const nl = l >= 0.22 && l <= 0.62 ? Math.min(0.66, l + 0.08) : l
      ;[nr, ng, nb] = hslToRgb(TARGET_HUE, ns, nl)
    }
    out[j] = nr; out[j + 1] = ng; out[j + 2] = nb; out[j + 3] = a
  }
  return { width, height, data: out }
}

/** Area-average downscale of an RGBA buffer to size×size. */
function downscale({ width, height, data }, size) {
  const out = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const x0 = Math.floor((x * width) / size), x1 = Math.max(x0 + 1, Math.floor(((x + 1) * width) / size))
      const y0 = Math.floor((y * height) / size), y1 = Math.max(y0 + 1, Math.floor(((y + 1) * height) / size))
      let r = 0, g = 0, b = 0, a = 0, n = 0
      for (let sy = y0; sy < y1; sy++) for (let sx = x0; sx < x1; sx++) {
        const k = (sy * width + sx) * 4
        r += data[k]; g += data[k + 1]; b += data[k + 2]; a += data[k + 3]; n++
      }
      const o = (y * size + x) * 4
      out[o] = Math.round(r / n); out[o + 1] = Math.round(g / n); out[o + 2] = Math.round(b / n); out[o + 3] = Math.round(a / n)
    }
  }
  return { width: size, height: size, data: out }
}

const wanted = process.argv.slice(2)
const files = (wanted.length ? wanted.map((n) => `${n}.png`) : readdirSync(DIR).filter((f) => f.endsWith('.png')))
  .filter((f) => !f.startsWith('store-icon'))

for (const f of files) {
  const path = resolve(DIR, f)
  try {
    const corrected = recolor(decodePNG(readFileSync(path)))
    writeFileSync(path, encodePNG(corrected.width, corrected.height, corrected.data))
    console.log(`recolored ${basename(path)} (${corrected.width}×${corrected.height})`)
    if (basename(path) === 'logo.png') {
      const icon = downscale(corrected, 128)
      const iconPath = resolve(DIR, 'store-icon-128.png')
      writeFileSync(iconPath, encodePNG(128, 128, icon.data))
      console.log(`wrote ${basename(iconPath)} (128×128, from corrected logo)`)
    }
  } catch (e) {
    console.error(`FAILED ${f}: ${e.message}`)
  }
}
