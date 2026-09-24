import { spawn } from 'child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import * as path from 'path'
import { logEvent } from 'src/services/analytics/index.js'
import { logForDebugging } from './debug.js'
import { distRoot } from './distRoot.js'
import { isEnvTruthy } from './envUtils.js'

// Auto-install / self-update ripgrep. The repo vendors prebuilt rg binaries
// for common platforms under src/utils/vendor/ripgrep/; platforms without a
// vendored binary (e.g. Windows arm64) download on first use. When a vendored
// binary is present but older than RG_VERSION, a silent background update
// downloads to a /tmp staging dir, verifies, then atomically replaces it.

export const RG_VERSION = '15.2.0'

const RG_RELEASE_BASE = `https://github.com/BurntSushi/ripgrep/releases/download/${RG_VERSION}`

// Prefix-style GitHub release accelerators. Only used when the exit IP is
// in mainland China (direct GitHub is fine elsewhere). CCB_RG_MIRRORS
// (comma-separated) overrides this list. All of them fall back to the
// official URL when none passes the speed test.
const DEFAULT_MIRRORS = [
  'https://ghproxy.net',
  'https://gh-proxy.com',
  'https://ghfast.top',
  'https://ghproxy.vip',
  'https://gh.llkk.cc',
  'https://gh-proxy.ygxz.in',
  'https://github.akams.cn',
  'https://gh.jasonzeng.dev',
  'https://gh.felicity.ac.cn',
  'https://gitproxy.dev',
  'https://gh.con.sh',
  'https://gh.ddlc.top',
  'https://ghps.cc',
  'https://git.xfj0.cn',
  'https://github.91chi.fun',
  'https://proxy.zyun.vip',
  'https://gh2.yanqishui.work',
  'https://ghdl.feizhuqwq.cf',
  'https://gh.api.99988866.xyz',
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
      : DEFAULT_MIRRORS
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

// ── vendor layout ────────────────────────────────────────────────────────────

type AssetSpec = { file: string; kind: 'tar.gz' | 'zip' }

// Mirrors getRipgrepConfig's ${process.arch}-${process.platform} layout.
export function rgAssetSpec(platform: string, arch: string): AssetSpec | null {
  if (platform === 'win32') {
    if (arch === 'x64') return { file: `ripgrep-${RG_VERSION}-x86_64-pc-windows-msvc.zip`, kind: 'zip' }
    if (arch === 'arm64') return { file: `ripgrep-${RG_VERSION}-aarch64-pc-windows-msvc.zip`, kind: 'zip' }
    if (arch === 'ia32') return { file: `ripgrep-${RG_VERSION}-i686-pc-windows-msvc.zip`, kind: 'zip' }
    return null
  }
  if (platform === 'darwin') {
    if (arch === 'arm64') return { file: `ripgrep-${RG_VERSION}-aarch64-apple-darwin.tar.gz`, kind: 'tar.gz' }
    if (arch === 'x64') return { file: `ripgrep-${RG_VERSION}-x86_64-apple-darwin.tar.gz`, kind: 'tar.gz' }
    return null
  }
  if (platform === 'linux') {
    if (arch === 'arm64') return { file: `ripgrep-${RG_VERSION}-aarch64-unknown-linux-gnu.tar.gz`, kind: 'tar.gz' }
    if (arch === 'x64') return { file: `ripgrep-${RG_VERSION}-x86_64-unknown-linux-musl.tar.gz`, kind: 'tar.gz' }
    return null
  }
  return null
}

/** Vendor directory for the running platform (created on install). */
export function rgVendorDir(platform = process.platform, arch = process.arch): string {
  const dir = platform === 'win32' ? `${arch}-win32` : `${arch}-${platform}`
  return path.resolve(distRoot, 'vendor', 'ripgrep', dir)
}

/** Binary path inside the vendor dir, mirroring getRipgrepConfig. */
export function rgVendorBinary(platform = process.platform, arch = process.arch): string {
  const name = platform === 'win32' ? 'rg.exe' : 'rg'
  return path.resolve(rgVendorDir(platform, arch), name)
}

function versionStamp(): string | null {
  try {
    return readFileSync(path.resolve(rgVendorDir(), '.version'), 'utf8').trim()
  } catch {
    return null
  }
}

// ── install / update ─────────────────────────────────────────────────────────

let installPromise: Promise<boolean> | null = null

/**
 * Ensure the vendored rg exists for this platform, downloading it on first
 * use (or when force-refreshing a stale binary). Single-flight.
 */
export function ensureVendoredRipgrep(force = false): Promise<boolean> {
  if (!force && existsSync(rgVendorBinary())) return Promise.resolve(true)
  installPromise ??= installRipgrep().finally(() => {
    installPromise = null
  })
  return installPromise
}

/**
 * Silent background self-update: vendored binary exists but its .version
 * stamp is older than RG_VERSION. Fire-and-forget; on success the caller's
 * memoized rg config is invalidated so the next call picks the new binary.
 */
export function refreshIfStale(onUpdated?: () => void): void {
  if (!existsSync(rgVendorBinary())) return
  if (versionStamp() === RG_VERSION) return
  logForDebugging(`[rg-install] stale vendored rg (${versionStamp()} < ${RG_VERSION}); background update`)
  void ensureVendoredRipgrep(true).then(ok => {
    if (ok) onUpdated?.()
  })
}

async function installRipgrep(): Promise<boolean> {
  if (isEnvTruthy(process.env.CCB_RG_SKIP_DOWNLOAD)) {
    logForDebugging('[rg-install] skipped via CCB_RG_SKIP_DOWNLOAD')
    return false
  }
  const spec = rgAssetSpec(process.platform, process.arch)
  if (!spec) {
    logForDebugging(`[rg-install] no release asset for ${process.arch}-${process.platform}`)
    return false
  }
  const started = Date.now()
  try {
    const githubUrl = `${RG_RELEASE_BASE}/${spec.file}`
    // Non-CN exits go direct only. CN (or undetectable) exits speed-test
    // every mirror in parallel and try fastest first; official stays last.
    let candidates: string[]
    if (await isMainlandChinaExit()) {
      const ranked = await rankedMirrors(githubUrl)
      candidates = [...ranked.map(m => `${m}/${githubUrl}`), githubUrl]
    } else {
      candidates = [githubUrl]
    }

    const workDir = mkdtempSync(path.resolve(tmpdir(), 'ccb-rg-'))
    let archive: Buffer | null = null
    for (const url of candidates) {
      logForDebugging(`[rg-install] trying ${url}`)
      const buf = await downloadArchive(url)
      if (buf && hasValidMagic(buf, spec.kind)) {
        archive = buf
        logForDebugging(`[rg-install] got valid archive from ${url}`)
        break
      }
      if (buf) logForDebugging(`[rg-install] bad payload (html/error page?) from ${url}`)
    }
    if (!archive) {
      logForDebugging('[rg-install] all sources failed')
      logEvent('rg_install_failed', { reason: 'all_sources' })
      return false
    }

    // Extract in the /tmp staging dir, then atomically swap into place.
    const archivePath = path.resolve(workDir, spec.file)
    writeFileSync(archivePath, archive)
    const extractDir = path.resolve(workDir, 'x')
    mkdirSync(extractDir, { recursive: true })
    // bsdtar (Windows 10+) handles zip; GNU tar handles tar.gz.
    await extractArchive(archivePath, extractDir)

    const extracted = findBinary(extractDir, process.platform === 'win32' ? 'rg.exe' : 'rg')
    if (!extracted) {
      logForDebugging('[rg-install] rg binary not found in archive')
      return false
    }
    installBinary(extracted)
    logForDebugging(`[rg-install] installed in ${Date.now() - started}ms`)
    logEvent('rg_install_ok', { ms: Date.now() - started })
    return true
  } catch (err) {
    logForDebugging(`[rg-install] failed: ${err instanceof Error ? err.message : String(err)}`)
    logEvent('rg_install_failed', { reason: 'exception' })
    return false
  }
}

/** Stage the verified binary into the vendor layout (tmp file → rename). */
function installBinary(src: string): void {
  const destDir = rgVendorDir()
  mkdirSync(destDir, { recursive: true })
  const destBin = rgVendorBinary()
  const staging = `${destBin}.download`
  copyFileSync(src, staging)
  if (process.platform !== 'win32') chmodSync(staging, 0o755)
  try {
    renameSync(staging, destBin)
  } catch {
    // Windows rename over an in-use binary can fail (EBUSY/EPERM); fall
    // back to a direct copy — the next update attempt will retry.
    copyFileSync(src, destBin)
  }
  writeFileSync(path.resolve(destDir, '.version'), RG_VERSION)
}

async function downloadArchive(url: string): Promise<Buffer | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(90_000) })
    if (!res.ok) {
      logForDebugging(`[rg-install] HTTP ${res.status} from ${url}`)
      return null
    }
    return Buffer.from(await res.arrayBuffer())
  } catch (err) {
    logForDebugging(
      `[rg-install] fetch error from ${url}: ${err instanceof Error ? err.message : String(err)}`,
    )
    return null
  }
}

/** Guard against HTML error/redirect pages being treated as archives. */
function hasValidMagic(buf: Buffer, kind: 'tar.gz' | 'zip'): boolean {
  if (buf.length < 8) return false
  if (kind === 'zip') return buf[0] === 0x50 && buf[1] === 0x4b // "PK"
  return buf[0] === 0x1f && buf[1] === 0x8b // gzip
}

function extractArchive(archivePath: string, destDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('tar', ['-xf', archivePath, '-C', destDir], {
      stdio: 'ignore',
      windowsHide: true,
    })
    child.on('error', () =>
      reject(new Error('tar unavailable; install tar or set CCB_RG_MIRRORS')),
    )
    child.on('exit', code =>
      code === 0 ? resolve() : reject(new Error(`tar exited ${code}`)),
    )
  })
}

function findBinary(root: string, name: string): string | null {
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop()!
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const full = path.resolve(dir, e.name)
      if (e.isDirectory()) stack.push(full)
      else if (e.name === name) return full
    }
  }
  return null
}
