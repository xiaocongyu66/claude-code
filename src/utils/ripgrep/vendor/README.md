# vendored ripgrep

Prebuilt `rg` binaries from the official ripgrep releases
(https://github.com/BurntSushi/ripgrep/releases), ripgrep 15.2.0.
ripgrep is licensed under the MIT license and the UNLICENSE (public
domain); see https://github.com/BurntSushi/ripgrep/blob/master/COPYING
for the full texts. Each platform dir carries a `.ccb-rg-version` stamp;
`scripts/postinstall.cjs` uses it to replace stale bundled binaries.

Layout mirrors the binary resolution in `src/utils/ripgrep/`:
`<arch>-<platform>/rg` (Windows: `<arch>-win32/rg.exe`). At build time
this folder is copied to `dist/vendor/ripgrep/` and serves as the
offline last resort in the resolution chain: system PATH rg →
auto-downloaded (~/.claude) → these repo-vendored binaries.

Platforms without a vendored binary (or users with `USE_BUILTIN_RIPGREP=1`)
get the managed binary auto-downloaded on first use by
`src/utils/ripgrep/installer.ts` (ripgrep 15.2.0). Exit-IP aware: mainland
China egress runs a parallel 2 MB speed test across the mirror list and
downloads from the fastest (official URL as final fallback); other egress
goes direct. Stale managed binaries self-update silently in the
background (staged in /tmp, atomically swapped). `CCB_RG_SKIP_DOWNLOAD=1`
disables downloads; `CCB_RG_MIRRORS` overrides the mirror list (the live
list lives in `src/utils/ripgrep/ghproxy.txt`).
