import { defineConfig } from '@playwright/test'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  testDir: './test/e2e',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: 'line',
  use: {
    headless: false,
    viewport: { width: 1280, height: 800 },
  },
  webServer: {
    command: 'npm run dev',
    cwd: path.join(__dirname, 'landing'),
    url: 'http://localhost:5174',
    reuseExistingServer: true,
    timeout: 15_000,
  },
})
