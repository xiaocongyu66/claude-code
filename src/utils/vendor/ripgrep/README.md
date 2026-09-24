# vendored ripgrep

Prebuilt `rg` binaries from the official ripgrep releases
(https://github.com/BurntSushi/ripgrep/releases), ripgrep 14.1.0.
ripgrep is licensed under the MIT license and the UNLICENSE (public
domain); see https://github.com/BurntSushi/ripgrep/blob/master/COPYING
for the full texts.

Layout mirrors `getRipgrepConfig()` in `src/utils/ripgrep.ts`:
`<arch>-<platform>/rg` (Windows: `<arch>-win32/rg.exe`).

Platforms without a vendored binary are auto-downloaded on first use by
`src/utils/ripgrepInstaller.ts` (ripgrep 15.2.0, `CCB_RG_SKIP_DOWNLOAD=1`
to disable, `CCB_RG_DOWNLOAD_URL` to point at an internal mirror).
