import * as path from 'path'
import { distRoot } from '../distRoot.js'
import { getClaudeConfigHomeDir } from '../envUtils.js'

// Two distinct on-disk locations for rg binaries, shared by config.ts
// (resolution) and installer.ts (download target):
//   - user dir: ~/.claude/vendor/ripgrep/<arch>-<platform>/ — where the
//     installer downloads and self-updates (writable, survives upgrades)
//   - repo dir: distRoot/vendor/ripgrep/<arch>-<platform>/ — the
//     repo-vendored fallback copied there at build time (read-only)

function platformDir(platform: string, arch: string): string {
  return platform === 'win32' ? `${arch}-win32` : `${arch}-${platform}`
}

/** Binary name for the platform (rg.exe on Windows). */
export function rgBinaryName(platform = process.platform): string {
  return platform === 'win32' ? 'rg.exe' : 'rg'
}

/** Auto-download target (~/.claude or CLAUDE_CONFIG_DIR). */
export function rgUserDir(platform = process.platform, arch = process.arch): string {
  return path.resolve(
    getClaudeConfigHomeDir(),
    'vendor',
    'ripgrep',
    platformDir(platform, arch),
  )
}

export function rgUserBinary(
  platform = process.platform,
  arch = process.arch,
): string {
  return path.resolve(rgUserDir(platform, arch), rgBinaryName(platform))
}

/** Repo-vendored fallback (build-time copy of src/utils/ripgrep/vendor). */
export function rgBundledDir(platform = process.platform, arch = process.arch): string {
  return path.resolve(
    distRoot,
    'vendor',
    'ripgrep',
    platformDir(platform, arch),
  )
}

export function rgBundledBinary(
  platform = process.platform,
  arch = process.arch,
): string {
  return path.resolve(rgBundledDir(platform, arch), rgBinaryName(platform))
}
