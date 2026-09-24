import { spawn } from 'child_process'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import * as path from 'path'
import { logEvent } from 'src/services/analytics/index.js'
import { logForDebugging } from './debug.js'
import { distRoot } from './distRoot.js'
import { isEnvTruthy } from './envUtils.js'

// Auto-install ripgrep on first use. The repo vendors prebuilt rg binaries
// for the common platforms under src/utils/vendor/ripgrep/, but platforms
// without a vendored binary (e.g. Windows arm64, fresh clones) would
// otherwise fall back to "no ripgrep available". This module downloads the
// official release asset for the running platform once, extracts the rg
// binary into the same vendor layout getRipgrepConfig() already searches,
// and marks it with a .version stamp so upgrades can re-trigger.

export const RG_VERSION = '15.2.0'

const RG_RELEASE_BASE = `https://github.com/BurntSushi/ripgrep/releases/download/${RG_VERSION}`

// Mirror list for environments where github direct download is slow or
// blocked. Mirrors are prefix-style proxies: `${mirror}/${githubUrl}`.
// CCB_RG_MIRRORS (comma-separated) overrides the defaults; an empty entry
// in the list means "official direct".
const DEFAULT_MIRRORS = ['', 'https://gh-proxy.com', 'https://ghfast.top']

function mirrorBases(): string[] {
  const raw = process.env.CCB_RG_MIRRORS
  const list = raw
    ? raw.split(',').map(m => m.trim())
    : DEFAULT_MIRRORS
  return list
    .map(m => m.replace(/\/$/, ''))
    .filter(m => m === '' || /^https?:\/\//.test(m))
}

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
  const dir =
    platform === 'win32'
      ? `${arch}-win32`
      : `${arch}-${platform}`
  return path.resolve(distRoot, 'vendor', 'ripgrep', dir)
}

/** Binary path inside the vendor dir, mirroring getRipgrepConfig. */
export function rgVendorBinary(platform = process.platform, arch = process.arch): string {
  const name = platform === 'win32' ? 'rg.exe' : 'rg'
  return path.resolve(rgVendorDir(platform, arch), name)
}

let installPromise: Promise<boolean> | null = null

/**
 * Ensure the vendored rg exists for this platform, downloading it on first
 * use. Single-flight: concurrent callers share one install. Returns true
 * when a usable vendored binary is present afterwards.
 */
export function ensureVendoredRipgrep(): Promise<boolean> {
  if (existsSync(rgVendorBinary())) return Promise.resolve(true)
  installPromise ??= installRipgrep().finally(() => {
    installPromise = null
  })
  return installPromise
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
    // Official first unless a mirror list explicitly puts mirrors ahead;
    // each candidate is downloaded and magic-checked before use.
    const candidates = mirrorBases().map(base =>
      base === '' ? githubUrl : `${base}/${githubUrl}`,
    )
    const workDir = mkdtempSync(path.resolve(tmpdir(), 'ccb-rg-'))
    const extractDir = path.resolve(workDir, 'x')
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
      logForDebugging('[rg-install] all mirrors failed')
      logEvent('rg_install_failed', { reason: 'all_mirrors' })
      return false
    }

    const archivePath = path.resolve(workDir, spec.file)
    writeFileSync(archivePath, archive)
    mkdirSync(extractDir, { recursive: true })
    // bsdtar (Windows 10+) handles zip; GNU tar handles tar.gz.
    await extractArchive(archivePath, extractDir)

    const extracted = findBinary(extractDir, process.platform === 'win32' ? 'rg.exe' : 'rg')
    if (!extracted) {
      logForDebugging('[rg-install] rg binary not found in archive')
      return false
    }
    const destDir = rgVendorDir()
    mkdirSync(destDir, { recursive: true })
    const destBin = rgVendorBinary()
    copyFileSync(extracted, destBin)
    if (process.platform !== 'win32') chmodSync(destBin, 0o755)
    writeFileSync(path.resolve(destDir, '.version'), RG_VERSION)
    logForDebugging(`[rg-install] installed ${destBin} in ${Date.now() - started}ms`)
    logEvent('rg_install_ok', { ms: Date.now() - started })
    return true
  } catch (err) {
    logForDebugging(`[rg-install] failed: ${err instanceof Error ? err.message : String(err)}`)
    logEvent('rg_install_failed', { reason: 'exception' })
    return false
  }
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
      reject(new Error('tar unavailable; install tar or set CCB_RG_DOWNLOAD_URL')),
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
