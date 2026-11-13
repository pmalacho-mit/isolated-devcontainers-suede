# Your environment

You are in a **workspace** managed by `desolate` v3: a virtual machine of your own, in a
**domain**. Read this before diagnosing any network or git failure: most of what you cannot
reach is unreachable on purpose, and is not a bug in the project.

- Your checkouts are under `/workspaces/<owner>/<repo>`: the domain's clone of each of its
  repositories. You are in its main checkout, or in a worktree of your own at
  `/workspaces/<owner>/<repo>/.worktrees/<name>`. `cat ~/.desolate/workspace.json` says which.
- Other workspaces of your domain may be working in the same repositories at the same time,
  each in its own worktree. You share one `.git` with them: you can see their branches, and
  they can see yours. Workspaces of other domains see nothing of yours.
- `/desolate/` is desolate's: `/desolate/mirrors/` (read-only: what each remote has
  published), `desolate status` (say how your work is going; also `/desolate/status`), `/desolate/release/AGENTS.md`
  (this file).

## Git: commit freely; you cannot push, and need not try

**No credential exists in this VM, and there is no route to use one.**

- **Do:** commit, branch, rebase, stash, diff, log. `git fetch` works: `origin` is the
  read-only mirror, so it needs no key and no network.
- **To get what the remote has now:** `desolate fetch` asks the root to refresh the mirror,
  then fetches. `origin/main` is then current.
- **When your work is ready:** commit it, then `desolate offer` (in the checkout, on the
  branch). That hands the branch to the person, who reviews it and pushes it. **Offering is
  not pushing, and nothing you do here pushes.** Do not look for a token, install `gh`, or
  add a remote: there is nothing to find.
- **If an offer is refused** with "the root refused this domain's bundle", some branch in
  this clone (not necessarily yours) holds an object git considers dangerous: a `.git`
  directory inside a tree, a `.gitmodules` that is a link or names a command, a malformed
  object. Nothing new from this domain is taken until that branch is deleted. If you did
  not make it, set `orange` and say which branch; do not try other ways to send it.
- Do not add or remove worktrees of your own in a loop: other workspaces share this `.git`.
- LFS works: files check out from the mirror, and new large files travel with your offer.

## Saying how it's going: `desolate status`

```bash
desolate status set blue   "working: issue #42"
desolate status set orange "needs a human: which API version?"
desolate status set red    "the tests cannot run: no database"
desolate status set green  "ready: offered issue/42"
desolate status note "what I changed, for the other agents here"
desolate status board      # every checkout in this repository: its status and its note
```

One line, at most 200 characters. Colours: `gray`, `blue`, `green`, `yellow`, `orange`,
`red`. Unless your task says otherwise: blue working, orange needs a human, red failed, green
done, gray withdrawn (say why). It is shown to the person and read by scripts. It is never
acted on: `green` pushes nothing.

## Network: named HTTP and HTTPS, through a proxy; nothing else

This VM has no route to anything. Its one way out is a proxy that belongs to this workspace.

- **What works:** `http://` and `https://` to a **hostname**, on ports 80 and 443. You need
  no proxy settings: connections are redirected for you. TLS is end to end with the real
  server.
- **What does not, by design:** any other port; SSH (no `git+ssh`, no `scp`); an address
  without a name (`curl https://1.2.3.4` is refused); the host machine, the LAN, the root,
  other workspaces; ICMP. Do not retry these or work around them: say what you needed.
- Names resolve to a placeholder address (`198.18.0.1`) here. That is expected: the proxy
  resolves the real name. Do not "fix" `/etc/resolv.conf`.
- A refusal comes back as `403` with a line starting `desolate:` that says why. "Not on the
  domain's allowlist" means the person has limited this domain to listed hosts: ask them.
- Every request is logged with this workspace's name.

## Dev servers

Bind to `0.0.0.0` or `127.0.0.1` on any port from 1024 up, and that is all: desolate notices
the listener and publishes it. **The person opens it at this workspace's own hostname, on the
same port number**, not at `localhost`:

```bash
jq -r '"http://\(.domain)-\(.workspace)"' ~/.desolate/workspace.json   # the name's start
```

The exact URL is what the person's `desolate ports` shows; tell them the port. If a port you
wanted is already taken here, something else needs that number on their machine: let your
server move to the next one.

## Secrets: you hold names, not values

If your task needs an API key, the person has stored it for this domain under a NAME such as
`MYAPP-OPENAI-KEY`. `/desolate/inbox/secrets.json` lists the names, the hosts each may be
sent to, and the headers it is substituted in. Use the name wherever the key would go
(`export OPENAI_API_KEY=MYAPP-OPENAI-KEY`): on the way out, over HTTPS, toward those hosts
only, the name is replaced by the value. You never see the value, responses that echo it
are scrubbed back to the name, and looking for it is wasted effort. A name sent anywhere
else arrives as a name. If the name you need is not in the list, set `orange` and ask.

## Where you are running

If the project has a `devcontainer.json`, you are in its devcontainer, which runs inside
this workspace's VM: the project's own image, features and lifecycle commands, as written.
`/workspaces/<owner>/<repo>` is the same path in the container and in the VM. `docker` in
the VM (and in the container, if the spec gives it one) is the VM's own daemon; containers
you start reach the network the same way you do, through the workspace's proxy. A dev
server you start is reachable by the person at the workspace's own hostname, on the port
it listens on: tell them the port, not `localhost`.

If the project has no `devcontainer.json`, or it did not come up, you are in the VM itself,
with what its base image has (git, git-lfs, node, python3, curl, jq, docker). The person
may be watching in the workspace's editor (VSCodium in a browser tab); it is the same
place and the same files.

## When to stop and ask

Anything needing a push, a secret, a host the proxy refuses, SSH, or another domain's work.
These are the person's, from outside this VM, by design. Set `orange` with what you need.
