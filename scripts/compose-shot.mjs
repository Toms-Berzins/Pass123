// Compose a Chrome Web Store screenshot: center a popup snip on the brand
// background (screenshots/bg.png) with rounded corners + a soft drop shadow,
// and an optional caption. Outputs an upload-ready 1280x800 PNG.
//
//   node scripts/compose-shot.mjs raw-1.png screenshot-1.png
//   node scripts/compose-shot.mjs raw-1.png screenshot-1.png --caption "Generate strong passwords"
//   node scripts/compose-shot.mjs raw-1.png out.png --width 640 --bg screenshots/bg.png
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const CANVAS_W = 1280
const CANVAS_H = 800
const CORNER = 16

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// --- parse args ---
const argv = process.argv.slice(2)
const positional = []
const opts = { caption: '', width: 620, bg: resolve(root, 'screenshots', 'bg.png') }
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '--caption') opts.caption = argv[++i] ?? ''
  else if (a === '--width') opts.width = Number(argv[++i])
  else if (a === '--bg') opts.bg = resolve(process.cwd(), argv[++i])
  else positional.push(a)
}
const [input, output] = positional
if (!input || !output) {
  console.error('Usage: node scripts/compose-shot.mjs <input> <output> [--caption "..."] [--width 620] [--bg path]')
  process.exit(1)
}
const inputPath = resolve(process.cwd(), input)
const outputPath = resolve(process.cwd(), output)

if (!existsSync(opts.bg)) {
  console.error(`Background not found: ${opts.bg}\nRun: node scripts/gen-bg.mjs`)
  process.exit(1)
}
if (!existsSync(inputPath)) {
  console.error(`Input not found: ${inputPath}`)
  process.exit(1)
}

const escapeXml = (s) =>
  s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c])

// --- resize the snip to fit, preserving aspect ---
const hasCaption = opts.caption.trim().length > 0
const maxW = Math.min(opts.width, CANVAS_W - 120)
const maxH = hasCaption ? CANVAS_H - 220 : CANVAS_H - 120

const resized = await sharp(inputPath)
  .resize({ width: maxW, height: maxH, fit: 'inside', withoutEnlargement: false })
  .ensureAlpha()
  .png()
  .toBuffer()
const { width: w, height: h } = await sharp(resized).metadata()

// --- rounded corners (dest-in mask) ---
const mask = Buffer.from(`<svg width="${w}" height="${h}"><rect width="${w}" height="${h}" rx="${CORNER}" ry="${CORNER}"/></svg>`)
const rounded = await sharp(resized).composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer()

// --- soft drop shadow ---
const shadowSrc = Buffer.from(
  `<svg width="${w}" height="${h}"><rect width="${w}" height="${h}" rx="${CORNER}" ry="${CORNER}" fill="black" fill-opacity="0.5"/></svg>`,
)
const shadow = await sharp(shadowSrc).extend({ top: 40, bottom: 40, left: 40, right: 40, background: { r: 0, g: 0, b: 0, alpha: 0 } }).blur(22).png().toBuffer()

// --- layout ---
const contentTop = hasCaption
  ? Math.max(150, Math.round((CANVAS_H - h) / 2) + 36)
  : Math.round((CANVAS_H - h) / 2)
const left = Math.round((CANVAS_W - w) / 2)

const layers = [
  { input: shadow, left: left - 40, top: contentTop - 40 + 16 }, // shadow, nudged down
  { input: rounded, left, top: contentTop },
]

if (hasCaption) {
  const caption = Buffer.from(
    `<svg width="${CANVAS_W}" height="120">
       <text x="${CANVAS_W / 2}" y="78" text-anchor="middle"
             font-family="Segoe UI, Helvetica, Arial, sans-serif" font-weight="600"
             font-size="40" fill="#a7f3d0">${escapeXml(opts.caption)}</text>
     </svg>`,
  )
  layers.push({ input: caption, left: 0, top: 40 })
}

await sharp(opts.bg)
  .resize(CANVAS_W, CANVAS_H, { fit: 'cover' })
  .composite(layers)
  // Chrome Web Store requires 24-bit PNG with no alpha channel. Flatten the
  // composited result onto an opaque background, then drop the alpha channel
  // (flatten alone leaves a redundant alpha channel in this sharp version).
  .flatten({ background: '#0c1611' })
  .removeAlpha()
  .png()
  .toFile(outputPath)

console.log(`Wrote ${outputPath} (${CANVAS_W}x${CANVAS_H}) — snip ${w}x${h}${hasCaption ? `, caption "${opts.caption}"` : ''}`)
