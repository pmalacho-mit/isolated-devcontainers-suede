# Vendored: xterm.js, for the git terminal (host/git-web.ts)

Served by the host daemon to the person's browser, from this directory only (no CDN). Each
file is the npm package's own, unmodified, taken from the tarball whose integrity is the
registry's:

| file | package | tarball integrity (npm `dist.integrity`) | file sha256 |
|---|---|---|---|
| `xterm.js`, `xterm.css` | `@xterm/xterm@5.5.0` (`lib/xterm.js`, `css/xterm.css`) | `sha512-hqJHYaQb5OptNunnyAnkHyM8aCjZ1MEIDTQu1iIbbTD/xops91NB5yq1ZK/dC2JDbVWtF23zUtl9JE2NqwT87A==` | `1f991ac3b4b283ebf96e60ae23a00a52765dd3a2e46fa6fdda9f1aab032f7495`, `ba8e6985669488981ccf40c0cefe3aba80722cb6c92de7ad628b0bd717faf2b6` |
| `addon-fit.js` | `@xterm/addon-fit@0.10.0` (`lib/addon-fit.js`) | `sha512-UFYkDm4HUahf2lnEyHvio51TNGiLK66mqP2JoATy7hRZeXaGMRDr00JiSF7m63vR5WKATF605yEggJKsw0JpMQ==` | `bdaefa370b1bfc42ee88d46fe6072400902a4d4b2d45cd93438dda9b23c97089` |

MIT licensed: `LICENSE-xterm`. T1 (`tests/v3/t1/git-web.test.ts`) checks the sha256 of each.

Re-vendoring (deliberately): `npm pack @xterm/xterm@<v> @xterm/addon-fit@<v>` in an empty
directory, compare each tarball's sha512 with `npm view <pkg>@<v> dist.integrity`, extract
with `tar -xzf` (no install scripts run), copy the three files, and update this table.

What xterm.js is given to draw is a terminal's output: bytes a file or a commit in the git
VM holds, which an agent may have written. xterm.js interprets escape sequences; the page
turns off what could reach beyond the terminal (links do nothing; there is no clipboard
addon; titles are ignored).
