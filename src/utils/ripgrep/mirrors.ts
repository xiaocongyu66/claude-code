import { logForDebugging } from '../debug.js'

// Mirror selection for rg downloads. The live list lives in the repo
// (ghproxy.txt, one proxy per line) so proxies can be added/retired
// without shipping code — fetched via jsDelivr git-tree CDNs, first valid
// responder wins. Priority: CCB_RG_MIRRORS env > remote list > fallback.
// Only mainland-China egresses use mirrors at all; everything ends at the
// official GitHub URL as the final fallback.

const GH_REPO = 'xiaocongyu66/claude-code'
const REPO_TAG = 'main'

const MIRROR_LIST_HOSTS = [
  'https://cdn.jsdmirror.com',
  'https://gcore.jsdelivr.net',
  'https://gcore.jsdelivr.com',
]
const MIRROR_LIST_PATH = `gh/${GH_REPO}@${REPO_TAG}/src/utils/ripgrep/ghproxy.txt`

const FALLBACK_MIRRORS = [
  'https://ghproxy.net',
  'https://gh.felicity.ac.cn',
  'https://gh.jasonzeng.dev',
  'https://github.akams.cn',
  'https://ghproxy.vip',
  'https://gh-proxy.ygxz.in',
  'https://gh.llkk.cc',
  'https://gh.api.99988866.xyz',
  'https://gh.con.sh',
  'https://gh.ddlc.top',
  'https://gh2.yanqishui.work',
  'https://ghdl.feizhuqwq.cf',
  'https://ghproxy.com',
  'https://ghps.cc',
  'https://git.xfj0.cn',
  'https://github.91chi.fun',
  'https://proxy.zyun.vip',
  'https://gh-proxy.com',
  'https://ghfast.top',
]

// ── exit IP detection ────────────────────────────────────────────────────────

let cnExitCache: boolean | null = null

/**
 * True when the egress IP is in mainland China (use mirrors). Undetectable
 * network fails open to CN behavior — mirrors are probed by speed anyway
 * and the official URL remains the final fallback.
 */
export async function isMainlandChinaExit(): Promise<boolean> {
  if (cnExitCache !== null) return cnExitCache
  const probes: Array<{ url: string; pick: (d: unknown) => string | undefined }> = [
    { url: 'https://api.ip.sb/geoip', pick: d => (d as { country_code?: string })?.country_code },
    { url: 'https://ipapi.co/json/', pick: d => (d as { country_code?: string })?.country_code },
    { url: 'http://ip-api.com/json/?fields=countryCode', pick: d => (d as { countryCode?: string })?.countryCode },
  ]
  for (const p of probes) {
    try {
      const res = await fetch(p.url, { signal: AbortSignal.timeout(4000) })
      if (!res.ok) continue
      const code = p.pick(await res.json())
      if (code) {
        cnExitCache = code.toUpperCase() === 'CN'
        logForDebugging(`[rg-install] exit IP ${code} → ${cnExitCache ? 'mirrors' : 'direct'}`)
        return cnExitCache
      }
    } catch {
      // next probe
    }
  }
  cnExitCache = true
  return cnExitCache
}

// ── remote mirror list ───────────────────────────────────────────────────────

let remoteMirrorCache: string[] | null = null

async function fetchRemoteMirrorList(): Promise<string[] | null> {
  if (remoteMirrorCache) return remoteMirrorCache
  try {
    const lines = await Promise.any(
      MIRROR_LIST_HOSTS.map(async host => {
        const res = await fetch(`${host}/${MIRROR_LIST_PATH}`, {
          signal: AbortSignal.timeout(6_000),
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const parsed = (await res.text())
          .split('\n')
          .map(l => l.trim().replace(/\/$/, ''))
          .filter(l => /^https?:\/\/[\w.-]/.test(l))
        if (parsed.length === 0) throw new Error('empty mirror list')
        return parsed
      }),
    )
    remoteMirrorCache = lines
    logForDebugging(`[rg-install] remote mirror list: ${lines.length} proxies`)
    return lines
  } catch {
    logForDebugging('[rg-install] remote mirror list unavailable; using fallback')
    return null
  }
}

// ── speed test (2 MB range probe per mirror) ────────────────────────────────

const SPEED_TEST_BYTES = 2 * 1024 * 1024

async function speedTestMirror(mirror: string, githubUrl: string): Promise<number> {
  const start = Date.now()
  try {
    const res = await fetch(`${mirror}/${githubUrl}`, {
      headers: { Range: `bytes=0-${SPEED_TEST_BYTES - 1}` },
      signal: AbortSignal.timeout(8_000),
    })
    if (!res.ok && res.status !== 206) return 0
    const size = (await res.arrayBuffer()).byteLength
    if (size < 100 * 1024) return 0
    return size / 1024 / ((Date.now() - start) / 1000) // KB/s
  } catch {
    return 0
  }
}

/** Mirrors ranked by measured KB/s (fastest first), dead ones dropped. */
export async function rankedMirrors(githubUrl: string): Promise<string[]> {
  const bases = (
    process.env.CCB_RG_MIRRORS
      ? process.env.CCB_RG_MIRRORS.split(',').map(m => m.trim())
      : ((await fetchRemoteMirrorList()) ?? FALLBACK_MIRRORS)
  )
    .map(m => m.replace(/\/$/, ''))
    .filter(m => /^https?:\/\//.test(m))
  const speeds = await Promise.all(
    bases.map(async m => ({ m, s: await speedTestMirror(m, githubUrl) })),
  )
  speeds.sort((a, b) => b.s - a.s)
  const ranked = speeds.filter(x => x.s > 0).map(x => x.m)
  logForDebugging(
    `[rg-install] mirror speed ranking: ${speeds.map(x => `${x.m.replace('https://', '')}=${Math.round(x.s)}KB/s`).join(' ')}`,
  )
  return ranked
}
