import { existsSync } from 'fs'
import memoize from 'lodash-es/memoize.js'
import { logEvent } from 'src/services/analytics/index.js'
import { isInBundledMode } from '../bundledMode.js'
import { logForDebugging } from '../debug.js'
import { isEnvTruthy } from '../envUtils.js'
import { execFileNoThrow } from '../execFileNoThrow.js'
import { findExecutable } from '../findExecutable.js'
import { logError } from '../log.js'
import { rgBundledBinary, rgUserBinary } from './layout.js'

export type RipgrepConfig = {
  mode: 'system' | 'user' | 'builtin' | 'embedded'
  command: string
  args: string[]
  argv0?: string
  note?: string
}

/**
 * rg resolution order:
 *   1. System rg already in PATH — use what the environment provides
 *      (USE_BUILTIN_RIPGREP=1 skips this to force a managed binary).
 *   2. Auto-downloaded rg (~/.claude/vendor/ripgrep) — kept fresh by
 *      the installer's background self-update.
 *   3. Repo-vendored rg (dist/vendor/ripgrep) — offline last resort.
 * When nothing exists yet we aim at the user dir; ensureRipgrepAvailable
 * downloads there before the first spawn.
 */
export const getRipgrepConfig = memoize((): RipgrepConfig => {
  // 1. System rg in PATH.
  if (!isEnvTruthy(process.env.USE_BUILTIN_RIPGREP)) {
    const { cmd: systemPath } = findExecutable('rg', [])
    if (systemPath !== 'rg') {
      // SECURITY: Use command name 'rg' instead of systemPath to prevent PATH hijacking
      // If we used systemPath, a malicious ./rg.exe in current directory could be executed
      // Using just 'rg' lets the OS resolve it safely with NoDefaultCurrentDirectoryInExePath protection
      return { mode: 'system', command: 'rg', args: [] }
    }
  }

  // In bundled (native) mode, ripgrep is statically compiled into bun-internal
  // and dispatches based on argv[0]. We spawn ourselves with argv0='rg'.
  if (isInBundledMode()) {
    return {
      mode: 'embedded',
      command: process.execPath,
      args: ['--no-config'],
      argv0: 'rg',
    }
  }

  // 2. Auto-downloaded binary.
  const userBin = rgUserBinary()
  if (existsSync(userBin)) {
    return { mode: 'user', command: userBin, args: [] }
  }

  // 3. Repo-vendored fallback.
  const bundledBin = rgBundledBinary()
  if (existsSync(bundledBin)) {
    return { mode: 'builtin', command: bundledBin, args: [] }
  }

  // 4. Nothing available yet — target the user dir for the download.
  return {
    mode: 'user',
    command: userBin,
    args: [],
    note: 'no ripgrep found; will auto-download on first use',
  }
})

/**
 * Pure function: decide what to do when the builtin rg binary may be missing.
 * Extracted so it can be tested without any module mocking.
 *
 * @param builtinPath  Path to the vendored rg binary.
 * @param systemRgPath  When omitted, calls `findExecutable('rg')` (production path).
 *                     Pass a string to force a specific system path, or `null` to
 *                     simulate "system rg not found".
 * @param platform     Override for `process.platform` (tests only).
 */
export function resolveBuiltinWithFallback(
  builtinPath: string,
  systemRgPath?: string | null,
  platform?: string,
): {
  mode: 'system' | 'builtin'
  command: string
  args: string[]
  note?: string
} {
  const p = platform ?? process.platform

  // Builtin exists — use it, no note.
  if (existsSync(builtinPath)) {
    return { mode: 'builtin', command: builtinPath, args: [] }
  }

  // Builtin missing — check system rg.
  // When systemRgPath is explicitly passed (including null), use it directly.
  // When undefined, call findExecutable (production path).
  const resolvedSystem =
    systemRgPath === undefined
      ? findExecutable('rg', []).cmd
      : (systemRgPath ?? 'rg')
  if (resolvedSystem !== 'rg') {
    return {
      mode: 'system',
      command: 'rg',
      args: [],
      note: `fallback: builtin rg unavailable on ${p}, using system rg`,
    }
  }

  // Neither available.
  return {
    mode: 'builtin',
    command: builtinPath,
    args: [],
    note: `no ripgrep available on ${p}; install ripgrep via apt/pkg/brew`,
  }
}

export function ripgrepCommand(): {
  rgPath: string
  rgArgs: string[]
  argv0?: string
} {
  const config = getRipgrepConfig()
  return {
    rgPath: config.command,
    rgArgs: config.args,
    argv0: config.argv0,
  }
}

/**
 * Awaitable pre-flight before spawning rg. When the vendored binary is
 * missing (fresh clone, uncommon platform) it downloads the release asset
 * once (mirror-accelerated on CN exits), then invalidates the memoized
 * config so the retry resolves to the freshly installed builtin. When the
 * binary exists but is stale, a silent background update runs instead —
 * the current call keeps using the old binary. Embedded and system modes
 * pass through immediately.
 */
export async function ensureRipgrepAvailable(): Promise<void> {
  const config = getRipgrepConfig()
  if (config.mode === 'system' || config.mode === 'embedded') return
  if (existsSync(config.command)) {
    refreshIfStale(() => getRipgrepConfig.cache.clear())
    return
  }
  const installed = await ensureVendoredRipgrep()
  if (installed) {
    getRipgrepConfig.cache.clear()
    logForDebugging('[rg] ripgrep installed; config re-resolved')
  }
}


// Singleton to store ripgrep availability status
let ripgrepStatus: {
  working: boolean
  lastTested: number
  config: RipgrepConfig
  note?: string
} | null = null

/**
 * Get ripgrep status and configuration info
 * Returns current configuration immediately, with working status if available
 */
export function getRipgrepStatus(): {
  mode: 'system' | 'user' | 'builtin' | 'embedded'
  path: string
  working: boolean | null // null if not yet tested
  note?: string
} {
  const config = getRipgrepConfig()
  return {
    mode: config.mode,
    path: config.command,
    working: ripgrepStatus?.working ?? null,
    note: ripgrepStatus?.note ?? config.note,
  }
}

/**
 * Test ripgrep availability on first use and cache the result
 */
export const testRipgrepOnFirstUse = memoize(async (): Promise<void> => {
  // Already tested
  if (ripgrepStatus !== null) {
    return
  }

  const config = getRipgrepConfig()

  try {
    let test: { code: number; stdout: string }

    // For embedded ripgrep, use Bun.spawn with argv0
    if (config.argv0) {
      // Only Bun embeds ripgrep.
      // eslint-disable-next-line custom-rules/require-bun-typeof-guard
      const proc = Bun.spawn([config.command, '--version'], {
        argv0: config.argv0,
        stderr: 'ignore',
        stdout: 'pipe',
      })

      // Bun's ReadableStream has .text() at runtime, but TS types don't reflect it
      const [stdout, code] = await Promise.all([
        (proc.stdout as unknown as Blob).text(),
        proc.exited,
      ])
      test = {
        code,
        stdout,
      }
    } else {
      test = await execFileNoThrow(
        config.command,
        [...config.args, '--version'],
        {
          timeout: 5000,
        },
      )
    }

    const working =
      test.code === 0 && !!test.stdout && test.stdout.startsWith('ripgrep ')

    ripgrepStatus = {
      working,
      lastTested: Date.now(),
      config,
      note: config.note,
    }

    logForDebugging(
      `Ripgrep first use test: ${working ? 'PASSED' : 'FAILED'} (mode=${config.mode}, path=${config.command})`,
    )

    // Log telemetry for actual ripgrep availability
    logEvent('tengu_ripgrep_availability', {
      working: working ? 1 : 0,
      using_system: config.mode === 'system' ? 1 : 0,
    })
  } catch (error) {
    ripgrepStatus = {
      working: false,
      lastTested: Date.now(),
      config,
      note: config.note,
    }
    logError(error)
  }
})

let alreadyDoneSignCheck = false
export async function codesignRipgrepIfNecessary() {
  if (process.platform !== 'darwin' || alreadyDoneSignCheck) {
    return
  }

  alreadyDoneSignCheck = true

  // Only sign the standalone vendored rg binary (npm builds)
  const config = getRipgrepConfig()
  if (config.mode !== 'builtin') {
    return
  }
  const builtinPath = config.command

  // First, check to see if ripgrep is already signed
  const lines = (
    await execFileNoThrow('codesign', ['-vv', '-d', builtinPath], {
      preserveOutputOnError: false,
    })
  ).stdout.split('\n')

  const needsSigned = lines.find(line => line.includes('linker-signed'))
  if (!needsSigned) {
    return
  }

  try {
    const signResult = await execFileNoThrow('codesign', [
      '--sign',
      '-',
      '--force',
      '--preserve-metadata=entitlements,requirements,flags,runtime',
      builtinPath,
    ])

    if (signResult.code !== 0) {
      logError(
        new Error(
          `Failed to sign ripgrep: ${signResult.stdout} ${signResult.stderr}`,
        ),
      )
    }

    const quarantineResult = await execFileNoThrow('xattr', [
      '-d',
      'com.apple.quarantine',
      builtinPath,
    ])

    if (quarantineResult.code !== 0) {
      logError(
        new Error(
          `Failed to remove quarantine: ${quarantineResult.stdout} ${quarantineResult.stderr}`,
        ),
      )
    }
  } catch (e) {
    logError(e)
  }
}
