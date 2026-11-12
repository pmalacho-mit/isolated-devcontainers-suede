# Security audit notes from the Mac bring-up (2026-11-11 onward)

Working notes from the agent on the M1, kept as the vz backend came up. Each item is
**open**, **fixed** (with where), or **accepted** (with why). Items move into
`decisions.md` or `release/docs/incidents.md` when they are settled.

## Fixed

1. **The root VM's ordinary user had passwordless sudo** (branch `mac/root-no-sudo`; also
   the links root's start-up followed, and the keyring's directory in the user's own). rootd, the state service and
   the git that parses agent-written packs run as Lima's login user. Lima gives that user
   `NOPASSWD: ALL` by default. If it does here, the keyring's own user protects nothing
   against a compromise of those processes: `sudo cat` reads the write keys.
   HANDOFF section 6 says keys are "safe from the root's unprivileged processes"; that is
   only true if those processes cannot sudo. **Confirmed** on the base VM (which the root
   is cloned from): `(ALL) NOPASSWD: ALL`. Worse than the git surface: each workspace's
   proxy (`proxy.ts`) and each domain's secrets proxy (mitmproxy) are spawned by rootd as
   this user, and they parse what workspaces send. A memory or logic bug in either is
   one `sudo` from every write key and every domain's secrets. Fixed: no sudo for that user;
   the host reaches root by ssh as root with Lima's key; root's things in a root-owned
   directory. `decisions.md`, "The root VM's ordinary user is not root".

## Open

2. **The proxies run as rootd's user, and secrets are that user's files.** A bug in
   mitmproxy or in `proxy.ts`, reached from any workspace, reads every domain's secret
   values and can write root clones and the registry. Fix: a user for the proxies; each
   domain's secrets readable by its secrets proxy only.
3. **The dashboard answers any local client, and hands out editor tokens.** The forwarder
   carries `desolate.localhost:31581` to the state service on its name alone; the service
   checks Host and Origin, which stops other web pages, not a local process (any user of
   the Mac, or a sandboxed app with network-client, can send any Host and no Origin).
   Measured: `curl -H 'Host: desolate.localhost:31581' http://127.0.0.1:31581/state`
   returns each workspace's editor address with its `tkn`, which is a terminal in that
   workspace (its code, its domain's secrets by use). `/diff` and `/action` are open the
   same way. The vz link was given a token precisely to keep other users and sandboxed
   programs out (`shared/link.ts`). Fix planned: a dashboard credential only the person's
   browser holds (an address with a token from `desolate ui`, exchanged for a cookie).
4. **Tools installed by version, not by hash.** `provision.sh` runs `pip install
   mitmproxy==11.0.2` and `npm install -g @devcontainers/cli@0.88.0`. The top-level version
   is fixed, the transitive dependencies are resolved at install time, unhashed. mitmproxy
   runs in the root VM, next to the domains' secrets. A lock with hashes for each
   (pip `--require-hashes`, npm `ci` from a shipped lockfile) would close it.
