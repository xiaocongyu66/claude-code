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

const RG_RELEASE_BASE =
  process.env.CCB_RG_DOWNLOAD_URL ??
  `https://github.com/BurntSushi/ripgrep/releases/download/${RG_VERSION}`

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
    const url = `${RG_RELEASE_BASE}/${spec.file}`
    logForDebugging(`[rg-install] downloading ${url}`)
    const res = await fetch(url, { signal: AbortSignal.timeout(120_000) })
    if (!res.ok) {
      logForDebugging(`[rg-install] download failed: HTTP ${res.status}`)
      logEvent('rg_install_failed', { reason: `http_${res.status}` })
      return false
    }
    const workDir = mkdtempSync(path.resolve(tmpdir(), 'ccb-rg-'))
    const archivePath = path.resolve(workDir, spec.file)
    writeFileSync(archivePath, Buffer.from(await res.arrayBuffer()))

    const extractDir = path.resolve(workDir, 'x')
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
