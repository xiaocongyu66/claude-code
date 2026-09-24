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
import { logForDebugging } from '../debug.js'
import { isEnvTruthy } from '../envUtils.js'
import { findWritablePathDir, rgUserBinary, rgUserDir } from './layout.js'
import { isMainlandChinaExit, rankedMirrors } from './mirrors.js'

// Download / self-update for ripgrep. Install target follows ripgrep's
// official convention: copy the binary into a writable $PATH directory so
// it becomes system-wide usable (`rg` in any shell); when no PATH entry is
// writable, fall back to the private ~/.claude vendor dir. Self-update
// scope is the private dir only — PATH installs are owned by the system.
// Resolution priority lives in config.ts: system PATH rg first, then this
// auto-downloaded binary, then the repo-vendored fallback.

export const RG_VERSION = '15.2.0'

const RG_RELEASE_BASE = `https://github.com/BurntSushi/ripgrep/releases/download/${RG_VERSION}`

type AssetSpec = { file: string; kind: 'tar.gz' | 'zip' }

// Mirrors the layout.ts ${arch}-${platform} directory scheme.
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

function versionStamp(): string | null {
  try {
    return readFileSync(
      path.resolve(rgUserDir(), VERSION_STAMP_NAME),
      'utf8',
    ).trim()
  } catch {
    return null
  }
}

let installPromise: Promise<boolean> | null = null

/**
 * Ensure the managed rg exists, downloading it on first use (or when
 * force-refreshing a stale binary). Single-flight.
 */
export function ensureVendoredRipgrep(force = false): Promise<boolean> {
  if (!force && existsSync(rgUserBinary())) return Promise.resolve(true)
  installPromise ??= installRipgrep().finally(() => {
    installPromise = null
  })
  return installPromise
}

/**
 * Silent background self-update: managed binary exists but its .version
 * stamp is older than RG_VERSION. Fire-and-forget; on success the caller's
 * memoized rg config is invalidated so the next call picks the new binary.
 */
export function refreshIfStale(onUpdated?: () => void): void {
  if (!existsSync(rgUserBinary())) return
  if (versionStamp() === RG_VERSION) return
  logForDebugging(`[rg-install] stale rg (${versionStamp()} < ${RG_VERSION}); background update`)
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

const VERSION_STAMP_NAME = '.ccb-rg-version'

/**
 * Stage the verified binary into place. Preferred target: a writable $PATH
 * directory (system-wide, per ripgrep's official install convention);
 * fallback: the private ~/.claude vendor dir. Staged tmp file → rename for
 * atomicity.
 */
function installBinary(src: string): void {
  const systemDir = findWritablePathDir()
  const destDir = systemDir ?? rgUserDir()
  mkdirSync(destDir, { recursive: true })
  const destBin = path.resolve(
    destDir,
    process.platform === 'win32' ? 'rg.exe' : 'rg',
  )
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
  writeFileSync(path.resolve(destDir, VERSION_STAMP_NAME), RG_VERSION)
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
