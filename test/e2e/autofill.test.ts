import {
  test,
  expect,
  createVault,
  addEntry,
  waitForIcons,
  clickIconFor,
  TEST_LOGIN_URL,
  NO_MATCH_URL,
  TEST_PASSWORD,
} from './fixtures.js'

const ENTRY = {
  title: 'Localhost test',
  url: 'localhost',
  username: 'testuser@example.com',
  password: 'SuperSecret99!',
}

test.describe('Pass123 autofill — localhost', () => {
  test.beforeAll(async ({ popupPage }) => {
    await createVault(popupPage, TEST_PASSWORD)
    await addEntry(popupPage, ENTRY)
  })

  test('icons are injected on the login form', async ({ extensionContext }) => {
    const page = await extensionContext.newPage()
    await page.goto(TEST_LOGIN_URL)
    await waitForIcons(page, 2)

    const count = await page.evaluate(() =>
      Array.from(document.querySelectorAll('div')).filter((el) =>
        Array.from(el.attributes).some((a) => a.name.startsWith('data-p123-')),
      ).length,
    )
    expect(count).toBeGreaterThanOrEqual(2)
    await page.close()
  })

  test('clicking the username icon fills both fields', async ({ extensionContext }) => {
    const page = await extensionContext.newPage()
    await page.goto(TEST_LOGIN_URL)
    await waitForIcons(page)

    await clickIconFor(page, '#username')

    await expect(page.locator('#username')).toHaveValue(ENTRY.username, { timeout: 5_000 })
    await expect(page.locator('#password')).toHaveValue(ENTRY.password)
    await page.close()
  })

  test('clicking icon when vault is locked — fields stay empty', async ({
    extensionContext,
    popupPage,
  }) => {
    // Lock via the popup.
    await popupPage.waitForSelector('#lockBtn:not([hidden])', { timeout: 5_000 })
    await popupPage.click('#lockBtn')
    await popupPage.waitForSelector('#unlock', { timeout: 5_000 })

    const page = await extensionContext.newPage()
    await page.goto(TEST_LOGIN_URL)
    await waitForIcons(page)

    await clickIconFor(page, '#username')
    await page.waitForTimeout(1_000)
    await expect(page.locator('#username')).toHaveValue('')

    // Re-unlock so the next test works.
    await popupPage.fill('#mp', TEST_PASSWORD)
    await popupPage.click('#unlock')
    await popupPage.waitForSelector('[data-tab="vault"]', { timeout: 8_000 })

    await page.close()
  })

  // Physical icon clicks in Playwright reach the INPUT (via handleFieldFocus) rather than the
  // shadow DOM button (handleIconClick) because the closed shadow host has pointer-events:none
  // and Playwright's mouse simulation doesn't penetrate into it. The openPopup→session-key→
  // popup-routing path is therefore tested here by sending the message directly, which is the
  // exact code path the content script exercises in a real browser.
  test('no saved logins for a different host — popup routes to add-entry form', async ({
    extensionContext,
    popupPage,
  }) => {
    // Ensure vault is unlocked.
    const isLocked = await popupPage.locator('#unlock').isVisible({ timeout: 1_000 }).catch(() => false)
    if (isLocked) {
      await popupPage.fill('#mp', TEST_PASSWORD)
      await popupPage.click('#unlock')
      await popupPage.waitForSelector('[data-tab="vault"]', { timeout: 8_000 })
    }

    // Confirm URL matching returns 0 entries for 127.0.0.1 (not the localhost entry).
    const matchResult = await popupPage.evaluate(
      async (hostname) =>
        new Promise<{ entries: unknown[]; locked: boolean }>((resolve) => {
          chrome.runtime.sendMessage({ type: 'matchesForHost', hostname }, (res) =>
            resolve(
              (res as { ok: boolean; data: { entries: unknown[]; locked: boolean } }).data,
            ),
          )
        }),
      '127.0.0.1',
    )
    expect(matchResult.locked).toBe(false)
    expect(matchResult.entries).toHaveLength(0)

    // Send openPopup with prefillHostname — this is what handleIconClick does on a no-match page.
    await popupPage.evaluate(
      async (hostname) =>
        new Promise<void>((resolve, reject) => {
          chrome.runtime.sendMessage(
            { type: 'openPopup', prefillHostname: hostname },
            (res) => {
              const r = res as { ok: boolean; error?: string }
              if (r?.ok) resolve()
              else reject(new Error(r?.error ?? 'openPopup failed'))
            },
          )
        }),
      '127.0.0.1',
    )

    // Reload the popup — route() reads p123_addEntry and renders the add-entry form.
    await popupPage.reload()
    await expect(popupPage.locator('#f-title')).toBeVisible({ timeout: 6_000 })
    await expect(popupPage.locator('#f-url')).toHaveValue('127.0.0.1')

    // Icons are still injected on the 127.0.0.1 page (icon injection is host-agnostic).
    const page = await extensionContext.newPage()
    await page.goto(NO_MATCH_URL)
    await waitForIcons(page)
    await page.close()
  })
})
