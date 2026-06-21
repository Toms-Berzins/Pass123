/**
 * URL / hostname matching for autofill and capture — the heart of v0.5's
 * "autofill robustness" moat. Pure, dependency-free, and heavily unit-tested so
 * it can carry real-site regression coverage as a standing workstream.
 *
 * The whole point: decide *which saved entry belongs to the page in front of us*
 * the way the big managers do — by registrable domain (eTLD+1), preferring the
 * most specific host match — and *which account* the user is actually using, so
 * we never offer or capture the wrong credential (wrong-account suppression).
 *
 * We do NOT bundle the full Public Suffix List (it's huge and would bloat the
 * extension). Instead we use a curated set of common multi-label suffixes plus a
 * last-two-labels fallback. This is a deliberate, documented heuristic: it gets
 * the common cases right (accounts.google.com↔google.com, foo.co.uk stays whole)
 * and degrades gracefully — at worst it over-groups an exotic TLD, never leaks a
 * secret to a different registrable domain in the common path.
 */

/**
 * Common multi-label public suffixes. If a host's last two labels are in here,
 * the registrable domain is the last *three* labels (e.g. `bbc.co.uk`, not `co.uk`).
 * Curated, not exhaustive — extend as real-site regressions surface.
 */
const MULTI_PART_SUFFIXES = new Set([
  // United Kingdom
  'co.uk', 'org.uk', 'me.uk', 'gov.uk', 'ac.uk', 'net.uk', 'sch.uk', 'ltd.uk', 'plc.uk',
  // Australia
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'id.au', 'asn.au',
  // New Zealand
  'co.nz', 'net.nz', 'org.nz', 'govt.nz', 'ac.nz', 'geek.nz',
  // Japan
  'co.jp', 'or.jp', 'ne.jp', 'ac.jp', 'go.jp', 'gr.jp',
  // Brazil
  'com.br', 'net.br', 'org.br', 'gov.br', 'edu.br',
  // India
  'co.in', 'net.in', 'org.in', 'gen.in', 'firm.in', 'ind.in', 'gov.in', 'ac.in',
  // South Africa
  'co.za', 'org.za', 'net.za', 'gov.za', 'ac.za',
  // South Korea
  'co.kr', 'or.kr', 'ne.kr', 'go.kr', 'ac.kr',
  // China / Hong Kong / Taiwan
  'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'com.hk', 'org.hk', 'com.tw', 'org.tw',
  // Singapore / Malaysia / Indonesia / Thailand / Philippines / Vietnam
  'com.sg', 'com.my', 'co.id', 'co.th', 'or.th', 'com.ph', 'com.vn',
  // Misc commonly-seen
  'com.mx', 'com.tr', 'com.ar', 'com.co', 'com.ua', 'com.pl', 'com.eg', 'com.sa',
  'co.il', 'co.jp', 'com.ru', 'org.es',
])

/**
 * Multi-tenant platform suffixes: hosting/SaaS domains where each subdomain is a
 * *different tenant with its own credentials*. Treating these as a public suffix
 * (so `a.myshopify.com` and `b.myshopify.com` are distinct registrable domains)
 * stops one tenant's saved login from surfacing on another's — a real autofill
 * leak the bare last-two-labels rule would otherwise cause. A curated subset of
 * the PSL's "private" section; extend as real-site regressions surface.
 *
 * Deliberately excluded: domains with a *single* central login shared across all
 * subdomains (e.g. `wordpress.com`), and platforms whose suffix has three+ labels
 * the last-two lookup can't express (e.g. `s3.amazonaws.com`).
 */
const PLATFORM_SUFFIXES = new Set([
  'myshopify.com', // Shopify stores (per-store admin login)
  'herokuapp.com', // Heroku apps
  'appspot.com', // Google App Engine apps
  'azurewebsites.net', // Azure App Service
  'vercel.app', // Vercel deployments
  'netlify.app', // Netlify sites
  'onrender.com', // Render services
  'web.app', 'firebaseapp.com', // Firebase Hosting
  'pages.dev', 'workers.dev', // Cloudflare Pages / Workers
  'github.io', 'gitlab.io', // GitHub / GitLab Pages
  'blogspot.com', // Blogger
])

/** Lowercase a host, drop a trailing dot and any `:port`. Returns '' for falsy input. */
function cleanHost(hostname: string): string {
  return (hostname || '').trim().toLowerCase().replace(/\.$/, '').replace(/:\d+$/, '')
}

/** True for a literal IPv4 or (bracketed/colon'd) IPv6 host — these have no registrable domain. */
function isIpHost(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':') || host.startsWith('[')
}

/**
 * The registrable domain (eTLD+1) of a hostname.
 *  - `accounts.google.com` → `google.com`
 *  - `www.bbc.co.uk`       → `bbc.co.uk`
 *  - `localhost` / IPs     → returned unchanged (no registrable domain)
 */
export function registrableDomain(hostname: string): string {
  const host = cleanHost(hostname)
  if (!host || !host.includes('.') || isIpHost(host)) return host
  const parts = host.split('.')
  if (parts.length <= 2) return host
  const lastTwo = parts.slice(-2).join('.')
  if (MULTI_PART_SUFFIXES.has(lastTwo) || PLATFORM_SUFFIXES.has(lastTwo)) return parts.slice(-3).join('.')
  return lastTwo
}

/** Host with `www.` stripped, for exact-host comparison. */
export function canonicalHost(hostname: string): string {
  return cleanHost(hostname).replace(/^www\./, '')
}

/** True if two hosts share the same registrable domain (and it's non-empty). */
export function sameSite(a: string, b: string): boolean {
  const ra = registrableDomain(a)
  return ra !== '' && ra === registrableDomain(b)
}

/** Extract a hostname from a stored entry URL, which may be bare (`github.com`) or full. */
export function hostnameFromUrl(url: string): string {
  const raw = (url || '').trim()
  if (!raw) return ''
  try {
    return new URL(raw.includes('://') ? raw : `https://${raw}`).hostname
  } catch {
    // Last resort: take the first path-ish segment.
    return cleanHost(raw.split('/')[0])
  }
}

/**
 * How well an entry's stored URL matches a page hostname:
 *   3 = exact host (ignoring www)
 *   2 = one is a subdomain of the other, same registrable domain
 *   1 = same registrable domain (sibling subdomains)
 *   0 = no match
 */
export function matchScore(entryUrl: string, pageHostname: string): 0 | 1 | 2 | 3 {
  const entryHost = hostnameFromUrl(entryUrl)
  if (!entryHost || !pageHostname) return 0
  if (!sameSite(entryHost, pageHostname)) return 0

  const e = canonicalHost(entryHost)
  const p = canonicalHost(pageHostname)
  if (e === p) return 3
  if (e.endsWith(`.${p}`) || p.endsWith(`.${e}`)) return 2
  return 1
}

interface HasUrl {
  url: string
}

/**
 * Rank entries by how well they match `pageHostname`, best first, dropping
 * non-matches. Stable within a score band (preserves caller order, e.g. recency).
 */
export function rankMatches<T extends HasUrl>(entries: readonly T[], pageHostname: string): T[] {
  return entries
    .map((entry, i) => ({ entry, i, score: matchScore(entry.url, pageHostname) }))
    .filter((m) => m.score > 0)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map((m) => m.entry)
}

interface HasUsername {
  username: string
}

/**
 * Wrong-account suppression: given the username the user is actually using on the
 * page, keep only entries for that account. Case-insensitive, whitespace-trimmed.
 * If `username` is blank, returns the list unchanged (we don't know the account yet).
 */
export function filterByUsername<T extends HasUsername>(entries: readonly T[], username: string): T[] {
  const u = (username || '').trim().toLowerCase()
  if (!u) return [...entries]
  return entries.filter((e) => e.username.trim().toLowerCase() === u)
}
