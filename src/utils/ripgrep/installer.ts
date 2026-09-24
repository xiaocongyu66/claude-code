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

// Full multi-platform ripgrep installer, following the official README's
// per-platform install matrix (https://github.com/BurntSushi/ripgrep):
//
//   Debian/Ubuntu  release .deb  → dpkg -i (sudo -n when not root)
//   Fedora/RHEL    release .rpm  → rpm -i
//   other Linux    tarball       → rg into a writable $PATH dir
//   macOS          tarball       → rg into /usr/local/bin (PATH)
//   Windows        zip           → rg.exe into a writable PATH dir
//
// Package-manager installs get man pages / completions / clean uninstall;
// the tarball path is the universal fallback. Final safety net when no
// PATH entry is writable: the private ~/.claude vendor dir. Resolution
// priority lives in config.ts (system PATH rg → downloaded → vendored).

export const RG_VERSION = '15.2.0'

const RG_RELEASE_BASE = `https://github.com/BurntSushi/ripgrep/releases/download/${RG_VERSION}`

type AssetSpec = { file: string; kind: 'tar.gz' | 'zip' | 'deb' | 'rpm' }

// Debian arch names: amd64 / arm64; RPM arch names: x86_64 / aarch64.
function debArch(arch: string): string | null {
  if (arch === 'x64') return 'amd64'
  if (arch === 'arm64') return 'arm64'
  return null
}
function rpmArch(arch: string): string | null {
  if (arch === 'x64') return 'x86_64'
  if (arch === 'arm64') return 'aarch64'
  return null
}

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
    const da = debArch(arch)
    if (da) return { file: `ripgrep_${RG_VERSION}-1_${da}.deb`, kind: 'deb' }
    const ra = rpmArch(arch)
    if (ra) return { file: `ripgrep-${RG_VERSION}-1.${ra}.rpm`, kind: 'rpm' }
    return null
  }
  return null
}

const VERSION_STAMP_NAME = '.ccb-rg-version'

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
 * Ensure a usable rg exists, installing it on first use (or when
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
 * Silent background self-update: managed binary exists but its stamp is
 * older than RG_VERSION. Fire-and-forget; on success the caller's
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
    // deb/rpm installs: extract nothing, hand the package to the system
    // package manager. On failure fall through to the tarball path.
    if (spec.kind === 'deb' || spec.kind === 'rpm') {
      const pkg = await downloadWithMirrors(spec)
      if (pkg) {
        const okPkg = await installSystemPackage(spec.file, pkg)
        if (okPkg) {
          logForDebugging(`[rg-install] system package installed in ${Date.now() - started}ms`)
          logEvent('rg_install_ok', { ms: Date.now() - started, kind: spec.kind })
          return true
        }
        logForDebugging('[rg-install] package manager install failed; falling back to tarball')
      }
    }

    // Universal tarball/zip path → writable PATH dir (or private dir).
    const archive = await downloadWithMirrors(spec)
    if (!archive) {
      logForDebugging('[rg-install] all sources failed')
      logEvent('rg_install_failed', { reason: 'all_sources' })
      return false
    }

    const workDir = mkdtempSync(path.resolve(tmpdir(), 'ccb-rg-'))
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
    logEvent('rg_install_ok', { ms: Date.now() - started, kind: 'binary' })
    return true
  } catch (err) {
    logForDebugging(`[rg-install] failed: ${err instanceof Error ? err.message : String(err)}`)
    logEvent('rg_install_failed', { reason: 'exception' })
    return false
  }
}

// ── download (mirror-accelerated on CN egress) ──────────────────────────────

async function downloadWithMirrors(spec: AssetSpec): Promise<Buffer | null> {
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
  for (const url of candidates) {
    logForDebugging(`[rg-install] trying ${url}`)
    const buf = await downloadArchive(url)
    if (buf && hasValidMagic(buf, spec.kind)) {
      logForDebugging(`[rg-install] got valid payload from ${url}`)
      return buf
    }
    if (buf) logForDebugging(`[rg-install] bad payload (html/error page?) from ${url}`)
  }
  return null
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

/** Guard against HTML error/redirect pages being treated as payloads. */
function hasValidMagic(buf: Buffer, kind: AssetSpec['kind']): boolean {
  if (buf.length < 8) return false
  if (kind === 'zip') return buf[0] === 0x50 && buf[1] === 0x4b // "PK"
  if (kind === 'deb') return buf[0] === 0x21 && buf[1] === 0x3c // "!<ar"
  if (kind === 'rpm') return buf[0] === 0xed && buf[1] === 0xab // 0xedabeedb
  return buf[0] === 0x1f && buf[1] === 0x8b // gzip
}

// ── system package installs (deb/rpm) ───────────────────────────────────────

async function installSystemPackage(filename: string, pkg: Buffer): Promise<boolean> {
  const workDir = mkdtempSync(path.resolve(tmpdir(), 'ccb-rg-'))
  const pkgPath = path.resolve(workDir, filename)
  writeFileSync(pkgPath, pkg)
  // dpkg/rpm need root; try directly first (containers/root shells), then
  // a non-interactive sudo. No password prompts — failure → tarball path.
  const base = specInstallCommand(filename, pkgPath)
  const attempts: string[][] = []
  if (process.platform !== 'win32' && typeof process.getuid === 'function' && process.getuid() !== 0) {
    attempts.push(['sudo', '-n', base[0]!, ...base.slice(1)])
  }
  attempts.push(base)
  for (const argv of attempts) {
    const ok = await spawnAndWait(argv)
    if (ok) return true
  }
  return false
}

function specInstallCommand(filename: string, pkgPath: string): string[] {
  return filename.endsWith('.deb')
    ? ['dpkg', '-i', pkgPath]
    : ['rpm', '-i', pkgPath]
}

function spawnAndWait(argv: string[]): Promise<boolean> {
  return new Promise(resolve => {
    const child = spawn(argv[0]!, argv.slice(1), {
      stdio: 'ignore',
      windowsHide: true,
    })
    child.on('error', () => resolve(false))
    child.on('exit', code => resolve(code === 0))
  })
}

// ── binary install (tarball/zip path) ───────────────────────────────────────

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
