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
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = resolve(__dirname, '..', 'brand')
const MODEL = 'gemini-2.5-flash-image' // "Nano Banana"
const API_KEY = process.env.GEMINI_API_KEY

// Shared art-direction so every asset reads as one brand.
const STYLE =
  'Cyber-industrial dark UI aesthetic. Signal-green (#39ff6e) to deeper green (#2bd457) ' +
  'as the only accent, on a near-black (#09090f) background. Flat, modern, premium, ' +
  'high contrast, crisp edges, subtle inner top highlight and soft green outer glow. ' +
  'No text, no lettering, no words. Minimalist, lots of negative space, perfectly centered.'

/** Each spec → one brand/<name>.png. Aspect is baked into the prompt (robust across revisions). */
const SPECS = {
  'logo': {
    prompt:
      `App logo for a privacy-first password manager. A rounded-square badge filled with a ` +
      `vertical signal-green gradient, bearing a single clean dark padlock-with-keyhole glyph ` +
      `in the center. Square 1:1 composition, the badge filling most of the frame with even ` +
      `padding. ${STYLE}`,
  },
  'icon-flat': {
    prompt:
      `Ultra-minimal app icon: one bold dark keyhole shape centered on a rounded-square ` +
      `signal-green gradient tile. Extremely simple, legible even when tiny, no fine detail. ` +
      `Square 1:1 composition. ${STYLE}`,
  },
  'mark-glyph': {
    prompt:
      `A single padlock icon glyph rendered in glowing signal-green line/solid style, floating ` +
      `centered on a pure near-black background, no container/badge. Square 1:1 composition. ${STYLE}`,
  },
  'promo': {
    aspectRatio: '16:9',
    prompt:
      `Wide promotional hero image for a password manager browser extension. A large glowing ` +
      `signal-green padlock floating on the RIGHT side over a dark cyber-industrial backdrop with ` +
      `faint circuit texture and a soft radial green glow from the top. Cinematic, premium, with ` +
      `the entire LEFT HALF left as empty dark negative space for a title to be added later. ${STYLE}`,
  },
}

if (!API_KEY) {
  console.error('GEMINI_API_KEY is not set. Run: GEMINI_API_KEY=… node scripts/gen-logo.mjs')
  process.exit(1)
}

const wanted = process.argv.slice(2)
const names = wanted.length ? wanted : Object.keys(SPECS)

async function generate(name, prompt, aspectRatio) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': API_KEY },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
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
  const parts = json?.candidates?.[0]?.content?.parts ?? []
  const img = parts.find((p) => p.inlineData?.data || p.inline_data?.data)
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
  try {
    await generate(name, spec.prompt, spec.aspectRatio)
  } catch (e) {
    console.error(`FAILED ${name}: ${e.message}`)
  }
}
