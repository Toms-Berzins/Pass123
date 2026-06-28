import { test as base, chromium, type BrowserContext, type Page } from '@playwright/test'
import path from 'path'
import { fileURLToPath } from 'url'
import * as os from 'os'
import * as fs from 'fs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const DIST = path.resolve(__dirname, '../../dist')
export const TEST_PASSWORD = 'TestPass123!'
export const TEST_LOGIN_URL = 'http://localhost:5174/test-login.html'
/** Same server, different host — no vault entry exists for this IP hostname. */
export const NO_MATCH_URL = 'http://127.0.0.1:5174/test-login.html'

type WorkerFixtures = { extensionContext: BrowserContext; extensionId: string }
type TestFixtures = { popupPage: Page }

export const test = base.extend<TestFixtures, WorkerFixtures>({
  extensionContext: [
    async ({}, use) => {
      const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-pass123-'))
      const ctx = await chromium.launchPersistentContext(userDataDir, {
        headless: false,
        args: [
          `--disable-extensions-except=${DIST}`,
          `--load-extension=${DIST}`,
          '--no-sandbox',
        ],
      })
      await use(ctx)
      await ctx.close()
      fs.rmSync(userDataDir, { recursive: true, force: true })
    },
    { scope: 'worker' },
  ],

  extensionId: [
    async ({ extensionContext }, use) => {
      let [sw] = extensionContext.serviceWorkers()
      if (!sw) sw = await extensionContext.waitForEvent('serviceworker', { timeout: 10_000 })
      const id = new URL(sw.url()).hostname
      await use(id)
    },
    { scope: 'worker' },
  ],

  popupPage: async ({ extensionContext, extensionId }, use) => {
    const page = await extensionContext.newPage()
    await page.goto(`chrome-extension://${extensionId}/src/popup/index.html`)
    await use(page)
    await page.close()
  },
})

export { expect } from '@playwright/test'

export async function createVault(popupPage: Page, password = TEST_PASSWORD): Promise<void> {
  await popupPage.waitForSelector('#mp', { timeout: 8_000 })
  await popupPage.fill('#mp', password)
  await popupPage.fill('#mp2', password)
  await popupPage.click('#create')
  await popupPage.waitForSelector('#rec-saved', { timeout: 8_000 })
  await popupPage.check('#rec-saved')
  await popupPage.click('#rec-done')
  await popupPage.waitForSelector('[data-tab="vault"]', { timeout: 8_000 })
}

export async function addEntry(
  popupPage: Page,
  entry: { title: string; url: string; username: string; password: string },
): Promise<void> {
  await popupPage.click('[data-tab="vault"]')
  await popupPage.waitForSelector('#addBtn')
  await popupPage.click('#addBtn')
  await popupPage.waitForSelector('#f-title')
  await popupPage.fill('#f-title', entry.title)
  await popupPage.fill('#f-url', entry.url)
  await popupPage.fill('#f-user', entry.username)
  await popupPage.fill('#f-pass', entry.password)
  await popupPage.click('#save')
  await popupPage.waitForSelector('#addBtn', { timeout: 8_000 })
}

export async function waitForIcons(page: Page, count = 1): Promise<void> {
  await page.waitForFunction(
    (expected) =>
      Array.from(document.querySelectorAll('div')).filter((el) =>
        Array.from(el.attributes).some((a) => a.name.startsWith('data-p123-')),
      ).length >= expected,
    count,
    { timeout: 8_000, polling: 200 },
  )
}

export async function clickIconFor(page: Page, inputSelector: string): Promise<void> {
  const rect = await page.evaluate((sel) => {
    const el = document.querySelector<HTMLInputElement>(sel)
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { right: r.right, top: r.top, height: r.height }
  }, inputSelector)
  if (!rect) throw new Error(`Input not found: ${inputSelector}`)
  const x = rect.right + 4 + 10
  const y = rect.top + (rect.height - 20) / 2 + 10
  await page.mouse.click(x, y)
}
