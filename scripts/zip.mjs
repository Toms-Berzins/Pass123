// Package dist/ into pass123.zip for Chrome Web Store upload.
//
// Builds with CWS=1 so manifest.config.ts omits the `key` field (the Store rejects
// uploads that contain it), then zips the *contents* of dist/ — manifest.json must be
// at the archive root, not nested under a dist/ folder. Cross-platform, no extra deps:
// PowerShell Compress-Archive on Windows, `zip` elsewhere.
import { execSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { platform } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dist = resolve(root, 'dist')
const out = resolve(root, 'pass123.zip')

execSync('npm run build', { stdio: 'inherit', env: { ...process.env, CWS: '1' } })

if (existsSync(out)) rmSync(out)

if (platform() === 'win32') {
  execSync(
    `powershell -NoProfile -Command "Compress-Archive -Path '${dist}\\*' -DestinationPath '${out}' -Force"`,
    { stdio: 'inherit' },
  )
} else {
  execSync('zip -r ../pass123.zip .', { cwd: dist, stdio: 'inherit' })
}

console.log(`\nCreated ${out} — store-ready (key omitted).`)
