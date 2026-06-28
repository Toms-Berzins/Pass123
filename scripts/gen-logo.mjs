/* global Buffer, process, console, fetch */
/**
 * Generates Pass123 brand imagery with Nano Banana (Gemini 2.5 Flash Image)
 * via the Gemini REST API. No dependencies — Node built-ins + global fetch.
 *
 * Auth:  reads GEMINI_API_KEY from the environment (never hard-code it).
 * Run:   GEMINI_API_KEY=… node scripts/gen-logo.mjs [name1 name2 …]
 *        (no names = generate every spec below)
 *
 * Output: brand/<name>.png  (1024-ish px masters; derive icons/store art from these)
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = resolve(__dirname, '..', 'brand')
const MODEL = 'gemini-2.5-flash-image' // "Nano Banana"
const API_KEY = process.env.GEMINI_API_KEY

// Shared art-direction — dark premium glassmorphism, signal-green only.
const STYLE =
  'Dark premium glassmorphism aesthetic. Near-black (#09090f) background. ' +
  'Signal-green (#39ff6e) as the ONLY accent color — no blues, purples, oranges, or other hues. ' +
  'Dark glass surface with a subtle diagonal gradient from #13131e to #0e0e18, ' +
  'a thin specular highlight at the top edge (white at very low opacity, fading to nothing), ' +
  'and a soft signal-green outer glow. Premium, minimal, high contrast, crisp clean edges. ' +
  'No text, no letters, no words. No circuit boards, no PCB textures, no lens flares. ' +
  'Lots of negative space. Perfectly centered composition.'

// The brand mark: a horizontal key whose 3 teeth encode "1-2-3".
const MARK =
  'The brand mark is a single classic key icon rendered in solid signal-green (#39ff6e). ' +
  'The key is oriented horizontally: a circular ring bow (open center, ring silhouette) on the LEFT, ' +
  'a straight horizontal shaft/blade extending to the RIGHT. ' +
  'Along the BOTTOM edge of the shaft there are exactly THREE rectangular teeth pointing downward, ' +
  'spaced evenly from left to right, in strictly ascending heights — ' +
  'leftmost tooth is 1 unit tall, middle tooth is 2 units tall, rightmost tooth is 3 units tall ' +
  '(a clear 1:2:3 staircase). This encodes the product name "Pass123". ' +
  'The key is a clean flat silhouette — no gradients on the glyph itself, no extra details.'

const MARK_REF = resolve(__dirname, '..', 'brand', 'mark-glyph.png')

/**
 * Each spec → one brand/<name>.png.
 * refImage: path to a PNG used as a multimodal style reference (passed as inlineData).
 * Skipping mark-glyph — the existing one was approved; regenerate with: node scripts/gen-logo.mjs mark-glyph
 */
const SPECS = {
  'logo': {
    refImage: MARK_REF,
    prompt:
      `The attached image is the approved style reference for the Pass123 brand. ` +
      `Generate an app icon in EXACTLY that style: same dark glass rounded-square badge, ` +
      `same specular diagonal highlight, same signal-green key glyph, same ambient glow. ` +
      `${MARK} ` +
      `The key must be perfectly centered inside the badge. Square 1:1 composition. ` +
      `Solid dark background — NO transparency, NO white edges. ${STYLE}`,
  },
  'icon-flat': {
    refImage: MARK_REF,
    prompt:
      `The attached image is the approved style reference. ` +
      `Generate a flatter, more minimal version of that icon: same dark rounded-square, ` +
      `same signal-green key glyph, but with LESS glow, LESS specular — closer to pure flat dark. ` +
      `${MARK} ` +
      `Solid #09090f dark background filling the entire square — NO transparency, NO white edges, ` +
      `NO glow bleeding outside the badge. Maximum simplicity. Square 1:1 composition. ${STYLE}`,
  },
  'mark-glyph': {
    // ponytail: skipped by default — existing approved output kept. Pass name explicitly to regenerate.
    skip: true,
  },
  'promo': {
    refImage: MARK_REF,
    aspectRatio: '16:9',
    prompt:
      `The attached image shows the approved key glyph style for Pass123. ` +
      `Generate a wide 16:9 promotional hero image using THAT key in the same signal-green style. ` +
      `The key should be large, positioned on the RIGHT half of the image, ` +
      `with a soft ambient signal-green radial glow behind it. ` +
      `The ENTIRE LEFT HALF must be clean, empty, very dark (#09090f) negative space ` +
      `— reserved for a title overlay. Dark, cinematic, premium. ${STYLE}`,
  },
}

if (!API_KEY) {
  console.error('GEMINI_API_KEY is not set. Run: GEMINI_API_KEY=… node scripts/gen-logo.mjs')
  process.exit(1)
}

const wanted = process.argv.slice(2)
const names = wanted.length ? wanted : Object.keys(SPECS)

async function generate(name, prompt, aspectRatio, refImage) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`
  const parts = []
  if (refImage) {
    parts.push({ inlineData: { mimeType: 'image/png', data: readFileSync(refImage).toString('base64') } })
  }
  parts.push({ text: prompt })

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': API_KEY },
    body: JSON.stringify({
      contents: [{ parts }],
      generationConfig: {
        responseModalities: ['IMAGE'],
        ...(aspectRatio ? { imageConfig: { aspectRatio } } : {}),
      },
    }),
  })
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${await res.text()}`)
  }
  const json = await res.json()
  const resParts = json?.candidates?.[0]?.content?.parts ?? []
  const img = resParts.find((p) => p.inlineData?.data || p.inline_data?.data)
  const data = img?.inlineData?.data ?? img?.inline_data?.data
  if (!data) {
    throw new Error(`No image in response: ${JSON.stringify(json).slice(0, 500)}`)
  }
  const file = resolve(OUT_DIR, `${name}.png`)
  writeFileSync(file, Buffer.from(data, 'base64'))
  console.log(`wrote ${file} (${Math.round(Buffer.from(data, 'base64').length / 1024)} KB)`)
}

mkdirSync(OUT_DIR, { recursive: true })
for (const name of names) {
  const spec = SPECS[name]
  if (!spec) {
    console.error(`unknown spec "${name}" — known: ${Object.keys(SPECS).join(', ')}`)
    continue
  }
  if (spec.skip) {
    console.log(`skipped ${name} (approved — pass name explicitly to regenerate)`)
    continue
  }
  try {
    await generate(name, spec.prompt, spec.aspectRatio, spec.refImage)
  } catch (e) {
    console.error(`FAILED ${name}: ${e.message}`)
  }
}
