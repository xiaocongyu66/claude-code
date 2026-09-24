// ripgrep module: binary resolution, managed download/self-update, spawning.
//
// Resolution priority (config.ts):
//   1. system rg already in PATH
//   2. auto-downloaded rg (~/.claude/vendor/ripgrep) — installer.ts keeps
//      it fresh via silent background self-update (mirrors.ts accelerates
//      CN egresses; ghproxy.txt in this folder is the live mirror list)
//   3. repo-vendored rg (dist/vendor/ripgrep, copied from ./vendor) —
//      offline fallback
export {
  getRipgrepConfig,
  getRipgrepStatus,
  ensureRipgrepAvailable,
  ripgrepCommand,
  resolveBuiltinWithFallback,
  testRipgrepOnFirstUse,
  type RipgrepConfig,
} from './config.js'
export {
  ripGrep,
  ripGrepStream,
  countFilesRoundedRg,
  RipgrepTimeoutError,
} from './spawn.js'
export {
  ensureVendoredRipgrep,
  refreshIfStale,
  rgAssetSpec,
  RG_VERSION,
} from './installer.js'
export {
  isMainlandChinaExit,
  rankedMirrors,
} from './mirrors.js'
export {
  rgUserDir,
  rgUserBinary,
  rgBundledDir,
  rgBundledBinary,
} from './layout.js'
