import { describe, expect, it } from 'vitest'
import {
  canonicalHost,
  filterByUsername,
  hostnameFromUrl,
  matchScore,
  rankMatches,
  registrableDomain,
  sameSite,
} from './urlmatch'

describe('registrableDomain', () => {
  // Real-site regression table — extend as autofill bugs surface in the wild.
  const cases: Array<[string, string]> = [
    ['google.com', 'google.com'],
    ['www.google.com', 'google.com'],
    ['accounts.google.com', 'google.com'],
    ['signin.aws.amazon.com', 'amazon.com'],
    ['login.live.com', 'live.com'],
    ['bbc.co.uk', 'bbc.co.uk'],
    ['www.bbc.co.uk', 'bbc.co.uk'],
    ['news.bbc.co.uk', 'bbc.co.uk'],
    ['shop.example.com.au', 'example.com.au'],
    ['example.co.jp', 'example.co.jp'],
    ['a.b.c.example.co.in', 'example.co.in'],
    // Real login/SSO hosts from docs/AUTOFILL_REGRESSION.md — promote failures here.
    ['login.microsoftonline.com', 'microsoftonline.com'],
    ['id.atlassian.com', 'atlassian.com'],
    ['accounts.spotify.com', 'spotify.com'],
    ['signin.ebay.com', 'ebay.com'],
    ['myaccount.google.com', 'google.com'],
    ['secure.bankofamerica.com', 'bankofamerica.com'],
    ['localhost', 'localhost'],
    ['127.0.0.1', '127.0.0.1'],
    ['EXAMPLE.COM', 'example.com'],
    ['example.com.', 'example.com'],
    ['example.com:8443', 'example.com'],
    ['', ''],
  ]
  it.each(cases)('%s → %s', (input, expected) => {
    expect(registrableDomain(input)).toBe(expected)
  })
})

describe('registrableDomain — top-site login-host burn-in (2026-06-21)', () => {
  // Real login / SSO / account hostnames from the top ~50 sites, each → its
  // expected registrable domain. This pins autofill matching against the sites
  // users actually hit. When a real site mis-maps, add it here first.
  const topSites: Array<[string, string]> = [
    // Big global accounts
    ['login.yahoo.com', 'yahoo.com'],
    ['www.linkedin.com', 'linkedin.com'],
    ['idmsa.apple.com', 'apple.com'],
    ['appleid.apple.com', 'apple.com'],
    ['login.salesforce.com', 'salesforce.com'],
    ['account.adobe.com', 'adobe.com'],
    ['auth.services.adobe.com', 'adobe.com'],
    ['auth.uber.com', 'uber.com'],
    ['account.booking.com', 'booking.com'],
    ['www.airbnb.com', 'airbnb.com'],
    ['www.paypal.com', 'paypal.com'],
    ['www.dropbox.com', 'dropbox.com'],
    ['www.notion.so', 'notion.so'],
    ['www.figma.com', 'figma.com'],
    ['discord.com', 'discord.com'],
    ['x.com', 'x.com'],
    ['mail.proton.me', 'proton.me'],
    // Banking
    ['secure05c.chase.com', 'chase.com'],
    ['connect.secure.wellsfargo.com', 'wellsfargo.com'],
    ['online.citi.com', 'citi.com'],
    // Workspace / SSO providers (sibling subdomains → same site)
    ['app.slack.com', 'slack.com'],
    ['myworkspace.slack.com', 'slack.com'],
    ['us02web.zoom.us', 'zoom.us'],
    ['login.okta.com', 'okta.com'],
    ['myorg.okta.com', 'okta.com'],
    ['mytenant.auth0.com', 'auth0.com'],
    ['dash.cloudflare.com', 'cloudflare.com'],
    // Gaming / media
    ['accounts.nintendo.com', 'nintendo.com'],
    ['store.steampowered.com', 'steampowered.com'],
    ['steamcommunity.com', 'steamcommunity.com'],
    ['www.epicgames.com', 'epicgames.com'],
    // International + multi-part public suffixes
    ['amazon.co.uk', 'amazon.co.uk'],
    ['www.amazon.co.jp', 'amazon.co.jp'],
    ['login.yahoo.co.jp', 'yahoo.co.jp'],
    ['www.rakuten.co.jp', 'rakuten.co.jp'],
    ['account.gov.uk', 'account.gov.uk'],
    ['www.hsbc.co.uk', 'hsbc.co.uk'],
    ['nid.naver.com', 'naver.com'],
    ['passport.yandex.ru', 'yandex.ru'],
    ['login.taobao.com', 'taobao.com'],
    ['www.mercadolibre.com.ar', 'mercadolibre.com.ar'],
    // Multi-tenant platform suffixes — each subdomain is a DIFFERENT account, so
    // it must be its own registrable domain (else one tenant's login leaks onto
    // another's). These fail the bare last-two rule until PLATFORM_SUFFIXES covers them.
    ['mystore.myshopify.com', 'mystore.myshopify.com'],
    ['myapp.herokuapp.com', 'myapp.herokuapp.com'],
    ['myproject.vercel.app', 'myproject.vercel.app'],
    ['mysite.netlify.app', 'mysite.netlify.app'],
    ['myapp.web.app', 'myapp.web.app'],
    ['myapp.firebaseapp.com', 'myapp.firebaseapp.com'],
    ['myapp.azurewebsites.net', 'myapp.azurewebsites.net'],
    ['site.pages.dev', 'site.pages.dev'],
    ['username.github.io', 'username.github.io'],
  ]
  it.each(topSites)('%s → %s', (input, expected) => {
    expect(registrableDomain(input)).toBe(expected)
  })

  it('does not leak credentials across tenants on shared platforms', () => {
    expect(sameSite('store-a.myshopify.com', 'store-b.myshopify.com')).toBe(false)
    expect(sameSite('app-a.herokuapp.com', 'app-b.herokuapp.com')).toBe(false)
    expect(sameSite('proj-a.vercel.app', 'proj-b.vercel.app')).toBe(false)
  })

  it('still groups true sibling subdomains on real sites', () => {
    expect(sameSite('app.slack.com', 'myworkspace.slack.com')).toBe(true)
    expect(sameSite('idmsa.apple.com', 'appleid.apple.com')).toBe(true)
    expect(sameSite('login.okta.com', 'myorg.okta.com')).toBe(true)
  })
})

describe('canonicalHost', () => {
  it('lowercases and strips www, trailing dot, port', () => {
    expect(canonicalHost('WWW.Example.com')).toBe('example.com')
    expect(canonicalHost('login.example.com')).toBe('login.example.com')
    expect(canonicalHost('example.com:443')).toBe('example.com')
  })
})

describe('sameSite', () => {
  it('groups hosts by registrable domain', () => {
    expect(sameSite('accounts.google.com', 'mail.google.com')).toBe(true)
    expect(sameSite('accounts.google.com', 'www.google.com')).toBe(true)
    expect(sameSite('bbc.co.uk', 'news.bbc.co.uk')).toBe(true)
  })
  it('separates different registrable domains, incl. shared public suffixes', () => {
    expect(sameSite('foo.co.uk', 'bar.co.uk')).toBe(false)
    expect(sameSite('google.com', 'google.co.uk')).toBe(false)
    expect(sameSite('example.com', 'evil.com')).toBe(false)
  })
  it('confirms the cross-host SSO cases the checklist relies on', () => {
    // Same registrable domain → resolved by the direct (keyed) pending match.
    expect(sameSite('accounts.google.com', 'myaccount.google.com')).toBe(true)
    expect(sameSite('signin.ebay.com', 'ebay.com')).toBe(true)
    // Genuinely different registrable domains → only the same-tab fallback can pair
    // these (e.g. login.microsoftonline.com → the app you signed into).
    expect(sameSite('login.microsoftonline.com', 'office.com')).toBe(false)
    expect(sameSite('org.okta.com', 'someapp.com')).toBe(false)
  })
  it('is false for empty hosts', () => {
    expect(sameSite('', 'example.com')).toBe(false)
  })
})

describe('hostnameFromUrl', () => {
  it('handles bare and full URLs', () => {
    expect(hostnameFromUrl('github.com')).toBe('github.com')
    expect(hostnameFromUrl('https://github.com/login')).toBe('github.com')
    expect(hostnameFromUrl('http://www.example.com:8080/x')).toBe('www.example.com')
    expect(hostnameFromUrl('')).toBe('')
  })
})

describe('matchScore', () => {
  it('scores exact host highest', () => {
    expect(matchScore('https://github.com/login', 'github.com')).toBe(3)
    expect(matchScore('www.github.com', 'github.com')).toBe(3)
  })
  it('scores subdomain relationships above sibling subdomains', () => {
    expect(matchScore('example.com', 'login.example.com')).toBe(2)
    expect(matchScore('login.example.com', 'example.com')).toBe(2)
    expect(matchScore('mail.example.com', 'calendar.example.com')).toBe(1)
  })
  it('does not match across registrable domains', () => {
    expect(matchScore('foo.co.uk', 'bar.co.uk')).toBe(0)
    expect(matchScore('example.com', 'example.org')).toBe(0)
    expect(matchScore('', 'example.com')).toBe(0)
  })
})

describe('rankMatches', () => {
  const entries = [
    { url: 'mail.example.com', tag: 'sibling' },
    { url: 'https://login.example.com/', tag: 'parent-of-page' },
    { url: 'example.com', tag: 'apex' },
    { url: 'other.org', tag: 'unrelated' },
  ]
  it('returns best matches first and drops non-matches', () => {
    const ranked = rankMatches(entries, 'login.example.com')
    expect(ranked.map((e) => e.tag)).toEqual(['parent-of-page', 'apex', 'sibling'])
  })
  it('returns nothing for an unrelated host', () => {
    expect(rankMatches(entries, 'nope.test')).toEqual([])
  })
  it('is stable within a score band', () => {
    const sibs = [
      { url: 'a.example.com', tag: 'a' },
      { url: 'b.example.com', tag: 'b' },
    ]
    expect(rankMatches(sibs, 'c.example.com').map((e) => e.tag)).toEqual(['a', 'b'])
  })
})

describe('filterByUsername', () => {
  const entries = [
    { username: 'alice@example.com', id: 1 },
    { username: 'Bob', id: 2 },
    { username: 'alice@example.com', id: 3 },
  ]
  it('keeps only the matching account (case-insensitive)', () => {
    expect(filterByUsername(entries, 'ALICE@example.com').map((e) => e.id)).toEqual([1, 3])
    expect(filterByUsername(entries, 'bob').map((e) => e.id)).toEqual([2])
  })
  it('returns everything when the username is unknown', () => {
    expect(filterByUsername(entries, '').map((e) => e.id)).toEqual([1, 2, 3])
  })
})
