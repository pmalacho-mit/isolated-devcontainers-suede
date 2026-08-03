# Fixes for the loopback cookie jar

Run `./tests/probes/loopback-cookie-scope.sh` first. It answers two questions,
and only one combination of answers needs a fix at all:

| step 1: cookie is HttpOnly? | step 2: cookie alone authenticates? | what to do |
|---|---|---|
| no cookie set at all | — | nothing. The editor authenticates from `?tkn=` only; there is nothing in the shared jar to read. |
| yes, HttpOnly | yes | **A.** `document.cookie` cannot read it, but a hostile page can still make authenticated requests to `:3000` from your browser. That is CSRF, not token theft. |
| no | yes | **The bad case.** Any page on any `127.0.0.1` port reads the main editor's token. Fix with B, then C. |
| no | no | low. The cookie is not a credential on its own; still prefer B. |

The underlying fact is not going to change: **cookies are scoped by host, never by
port** (RFC 6265 §8.5). Every project's editor and dev server is on `127.0.0.1`,
so they are all one origin as far as the cookie jar is concerned. Any fix has to
change the *host*, not the port.

---

## A. Confirm it end to end before doing anything

The probe reads headers; this shows the actual browser behaviour, which is what
matters. Start any project, then from **inside that project's** terminal in the
browser editor:

```bash
mkdir -p /tmp/poc && cd /tmp/poc
cat > index.html <<'HTML'
<h1>a page served by a devcontainer</h1>
<pre id="out">reading...</pre>
<script>
  document.getElementById('out').textContent =
    document.cookie || '(nothing readable — cookies are HttpOnly)';
</script>
HTML
python3 -m http.server 5173 --bind 0.0.0.0
```

Declare `"customizations": {"desolate": {"ports": [5173]}}` in that project's
`devcontainer.json` first, so `desolate` allocates a host port for it. Open the
URL `desolate` prints, **in the same browser you use for the editor**.

If the page prints the editor's token, the exposure is real and A is confirmed.
If it prints the fallback line, the cookie is HttpOnly and you are in row 2.

## B. Give each surface its own hostname (recommended)

The cheapest real fix, because it changes the cookie *host* without touching
ports, TLS, or the relay chain.

`*.localhost` resolves to `127.0.0.1` in Chrome, Edge and Firefox without any
configuration (RFC 6761 §6.3). Safari does not, so add an `/etc/hosts` line for
Safari users.

The change is in `release/vscode-image/desolate.ts`, in the URL it prints:

```ts
console.log(
  `    http://127.0.0.1:${editorPort}/?tkn=${token}&folder=${folder}\n`,
);
```

becomes something like:

```ts
// A DISTINCT HOST per project, not just a distinct port. Cookie scope is
// (domain, path) and ignores the port entirely, so every project served on
// 127.0.0.1 shares one jar with the main editor -- and a project's own dev
// server is a page the user is told to open.
const host = `${volumeNamespace(name).replace(/_/g, "-")}.localhost`;
console.log(`    http://${host}:${editorPort}/?tkn=${token}&folder=${folder}\n`);
```

and the same for the dev-server URLs below it.

Nothing server-side needs to change: the relay binds `127.0.0.1:<port>` and does
not inspect `Host`. Only the URL the user opens changes, and with it the origin
and cookie jar the page runs in.

Then give the **main** editor its own name too, in `cli.sh`'s `editor_url`:

```bash
url="http://editor.desolate.localhost:$port/?tkn=$tok&folder=/workspaces"
```

Verify: after the change, the poc page from A prints `(nothing)` — it is on
`myproject.localhost`, a different cookie host from `editor.desolate.localhost`.

**Caveats to check before committing to this:**

- Safari and some Electron shells do not resolve `*.localhost`. Ship an
  `/etc/hosts` line, or use `127.0.0.2`, `127.0.0.3`… instead (they are distinct
  cookie hosts too, but on macOS each needs
  `sudo ifconfig lo0 alias 127.0.0.2 up`, which is worse ergonomics).
- openvscode-server may reject a `Host` it does not expect. Test one project
  before converting all the URLs.
- A project's own dev server is not affected either way; it never had the
  token.

## C. Stop the token being a cookie at all

Strictly better than B, and more work. The token is a bearer credential in a
shared jar; the shared jar is the problem, but so is the bearer token. Options,
roughly in order of effort:

1. **Check for an upstream flag.** `openvscode-server --help` may expose
   something for the connection-token cookie. If it can be made `HttpOnly`, that
   alone moves you from the bad row to row 2, for one line of compose config.
2. **Put a tiny auth proxy in front of the editor** that sets its own
   `HttpOnly; SameSite=Strict` session cookie and injects the connection token
   upstream. This is the standard shape, but it is a new component in the trust
   path, which this design has otherwise avoided.
3. **Per-project tokens are already in place** (`connectionToken()` in
   `desolate.ts` mints one per project). The main editor on `:3000` is the one
   worth protecting hardest, because it holds all of `/workspaces` *and* the
   broker socket. If you do nothing else, do B for that one.

## What NOT to do

- **Do not** rely on `SameSite`. It governs cross-*site* requests, and
  `127.0.0.1:8085` → `127.0.0.1:3000` is same-site. It does not help here.
- **Do not** move the dev-server range to a different port range. Ports are
  exactly what cookies ignore.
