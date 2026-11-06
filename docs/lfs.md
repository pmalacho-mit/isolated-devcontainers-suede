# Git LFS through `--push` and `--pull`

A project that tracks files with Git LFS now pushes and pulls them like any
other: `desolate --push` says which LFS objects it is about to upload and
uploads them before the commits that name them, and `desolate --pull` fetches
the objects of the branch it fast-forwards. This page records why it works the
way it does -- above all, **why git-lfs runs where it does, and what that costs
in security** -- and what is not yet known. (Issue #51; the probe is
[`tests/probes/lfs-deploy-key.sh`](../tests/probes/lfs-deploy-key.sh).)

## What the probe decided

| | question | result |
| --- | --- | --- |
| C0 | the key reaches its repository | yes |
| Q1 | `git-lfs-authenticate <repo> download` | yes -- an href at `lfs.github.com`, valid 599 s |
| Q2 | `git-lfs-authenticate <repo> upload` | yes -- an href at `lfs.github.com`, valid 21599 s |
| C1 | the same key, upload to `octocat/Hello-World` | refused: `bad_permissions ... denied to deploy key` |
| Q3 | an object goes up (65 bytes) | yes: batch 200, PUT to `github-cloud.s3.amazonaws.com` 200, verify at `lfs.github.com` 200 |
| Q4 | the same object comes back | yes: batch 200, GET from `github-cloud.githubusercontent.com` 200, sha256 equals the oid |
| Q5 | pure-SSH LFS (`git-lfs-transfer`) | **no** -- exit 1, "Invalid command" |

The deploy key `repo add` registered is enough, and it is scoped the way the
design needs (C1): no new secret, no token stored anywhere. Only the
*authentication* is SSH; the objects move over HTTPS to three hosts, so whoever
moves them needs a route to `lfs.github.com`, `github-cloud.s3.amazonaws.com`
and `github-cloud.githubusercontent.com`, and the download token lasts only ten
minutes.

## What happened before this

Measured by hand with git 2.51 and git-lfs 3.7.1 in a scratch directory:

- **A push sent the pointer and never the object.** A bundle holds git's
  objects; an LFS file is, there, a 130-byte pointer (`version
  https://git-lfs.github.com/spec/v1` / `oid sha256:...` / `size N`). The push
  ran with hooks off and no git-lfs, so nothing uploaded the object. The branch
  landed on GitHub with pointers GitHub could not resolve (inferred for GitHub's
  side; no write credential was at hand).
- **A pull could not check an LFS file out.** The sandbox's system filter is
  `filter.lfs.required=true`, the origin is an ssh alias nothing there can
  resolve, and the fast-forward failed on the smudge (`smudge filter lfs
  failed`, exit 128) -- reported as "uncommitted changes in the way?".
- **The first checkout of a new clone failed the same way**, leaving a
  half-written tree (some files written, the LFS file absent, everything
  staged-deleted).
- **Given the objects, the sandbox needed no network.** With the object in
  `.git/lfs/objects/aa/bb/<oid>` the same merge succeeded and produced the
  exact bytes.

## Why not simply run `git-lfs`? The security pressures

The obvious design is the one a person would use: run `git lfs` where the git
work is done. This page first proposed a small LFS client written in the editor
instead, and then dropped that too, for the reasons below. They are worth having
in one place because the answer is not obvious, and every alternative looks
simpler until it meets one of these facts.

**Fact 1 -- the deploy keys are in one place, and it cannot reach the network.**
They live in the `keyring` container (no network at all). The editor can *use*
them through an ssh-agent socket, never read them; SSH egress is blocked from
every devcontainer. So the one step of git-lfs that needs the key --
`git-lfs-authenticate`, which is how git-lfs gets its credential for an `ssh`
remote -- can only happen in the editor.

**Fact 2 -- the editor is the most privileged process and reaches every project,
and a project is executable configuration.** `.git/config`, `.git/hooks/`,
`.gitattributes` and `.lfsconfig` are all things a project (or an agent in its
devcontainer) can write, and each is consumed by git or git-lfs. This is not
hypothetical: incident M1 was the editor running the git-lfs filter over a
remote's content and its `.lfsconfig`
([incidents](../release/docs/incidents.md)). Everything in `transfer.ts` exists
so that the editor never runs a project's git.

**Fact 3 -- the sandbox sees one project, has proxied egress, and no key.** It is
where a project's git already runs (checkouts, merges, bundles), with the
project's own hooks and config and nothing else in reach. It *can* reach
`lfs.github.com` through the proxy (that is why it is handed the proxy's CA), and
it has the project's LFS objects. It cannot authenticate.

**Fact 4 -- git-lfs obeys the project's repository.** Measured against the real
binary with a stand-in LFS server (`tests/unit/desolate/lfs.test.ts` repeats it
on every run, with a second server playing the attacker):

| the project did | result |
| --- | --- |
| `lfs.url` / `lfs.pushurl` in `.git/config`, with a committed `.lfsconfig` | **overrode the endpoint passed as an argument**: the request went to the attacker's server |
| the same, with the endpoint pinned by `-c` / `GIT_CONFIG_*` | the pin won (the probe's commit measured the same for `.lfsconfig` in a bare repository) |
| `url.<attacker>.insteadOf = <real host>` | **rewrote even the pinned `lfs.url`**: the request went to the attacker |
| `http.proxy`, `http.sslVerify=false`, `credential.helper`, `core.fsmonitor` | not measured one by one; each would route, trust, ask or run something the project chose |

Pinning is therefore not enough. The *repository* git-lfs runs in has to be one
the project did not write.

### The options

| | where `git-lfs` runs | verdict |
| --- | --- | --- |
| A | the editor, in the project | **No.** Fact 2, and Fact 4's table is the attack: a project redirects the editor's credential. This is M1 again. |
| B | the editor, in its own cache of the remote, config pinned | Closes the redirect, but the key-holding process still runs a large Go binary over remote-controlled content, and the *objects* (which live in the project's `.git/lfs`) must be read out of the project into the editor and sent on: every byte crosses a trust boundary twice, and the editor needs disk for the largest object. A bug in the binary is a bug in the process that holds every key. |
| C | the editor, with a small client of our own in TypeScript (this page's first proposal) | Avoids the binary, but is a new HTTP client -- batch, retries, redirects, host checks, streaming, resumption -- in the same process, over responses from the network. It is more code, and more security-sensitive code, than the binary it replaces. |
| D | the editor's container, as a less-privileged user | The ssh-agent socket and the keyring's exports are reachable by anything in the container that can open them; a uid that cannot open them cannot authenticate, and one that can is the editor. It also still lacks the project's objects. It is the sandbox with extra steps. |
| **E** | **the project's sandbox, handed a credential minted by the editor** | **Chosen.** The binary runs where the objects and the egress are, as the user the project's git already runs as. The editor does only what needs the key, in a few lines. |

### What E is, and what it costs

The editor runs `git-lfs-authenticate <owner/repo> <download|upload>` over the
registration's host alias, so with that repository's key and no other. GitHub's
answer is an endpoint and one `Authorization` header. The editor checks it
strictly (below), writes it to a file of the transfer in the project's git dir
(`.git/desolate-transfer-<id>.lfsauth`), and the sandbox's script reads it, runs
git-lfs, and the file is deleted when the transfer ends. **No object passes
through the editor, the editor never runs git-lfs, and no project file is read
by anything holding a key.**

*In the sandbox*, git-lfs does not run in the project's repository (Fact 4). The
script makes a scratch bare repository whose only objects are the project's by
`objects/info/alternates` (read as data) and whose only configuration is the
environment's: the endpoint, the token for that endpoint alone, the proxy's CA,
`http.sslVerify=true`, no proxy, no credential helper, and `lfs.storage` naming
the project's LFS store. A project's `.git/config`, `.lfsconfig` and `insteadOf`
are not read by that process at all. The one git-lfs command that does run in
the project -- `git lfs checkout`, which fills in files whose objects are local
-- never touches the network.

**The price, stated plainly: for the length of a push or pull, the project's
sandbox -- and any agent running in the project's devcontainer, which can read
the file in `.git` -- can see a credential for that one repository's LFS
storage.** What that credential is:

- good for one repository (the project's registered one; C1 shows another is
  refused), and for its LFS objects only -- GitHub's LFS API is not its contents
  or branches;
- valid ten minutes for download and about six hours for upload, and the file is
  deleted when the transfer ends (not a revocation: a copy made meanwhile lives
  to its expiry);
- able to read that repository's LFS objects (the project's own data, which it
  can already read) and to upload objects to it. An uploaded object is
  unreferenced until a commit names it, and only the editor pushes commits. What
  an abused upload token costs is *storage quota* on that repository.

That is a weaker form of "usable while compromised, never copyable"
([README](../release/README.md#3-credentials-usable-while-compromised-never-copyable)):
the *deploy key* is still never copyable, and this token is bounded by time and
by repository. If that is more than you want, the alternatives are B and C,
which move the exposure from "a repository-scoped token in a project's sandbox"
to "a large binary, or a new network client, in the process that holds every
key".

### What the editor holds the credential to

`lfsAuthFrom` (`transfer.ts`) refuses anything but: an `https://lfs.github.com/`
endpoint whose path is this registration's `owner/repo` (optionally with `.git`
/ `/info/lfs`), and exactly one header, `Authorization`, of printable
characters. The answer is data from the network and becomes a config value and a
header in the sandbox, so a newline, a second header, another repository or
another host is refused before it is written anywhere. The sandbox's script
checks the file again (an https URL of URL characters, one `Authorization:`
line); it is the project's directory, so it cannot trust the file.

What the editor *cannot* check: the hosts the objects themselves go to
(`github-cloud...`) are named by GitHub's batch response, inside the sandbox. The
proxy's destination allowlist, which applies to every container, bounds them;
the batch token goes only to the endpoint above.

## How it works

**Push.** After the bundle is fetched into the cache and the default-branch and
`--expect` checks pass, the editor lists the LFS objects the new commits add:
`rev-list --objects <commit> --not --branches` in the *cache*, blobs of at most
1024 bytes, matched as git-lfs's three-line pointer exactly (by content, not by
`.gitattributes`). If there are none, nothing else happens -- no credential is
asked for. If there are, it **says so first**, then uploads, then pushes the
commit:

```
desolate: uploading 2 LFS objects (118 MiB) to acme/widgets's LFS storage, which counts against its owner's quota:
desolate:   assets/model.bin  118 MiB  3a85670cf3e7
desolate:   data/sample.bin  96 KiB  0b7c91e5d2aa
```

The sandbox runs `git lfs push --object-id` for exactly those oids; an object the
project's LFS store lacks fails it, naming the oid, and **the branch is not
pushed**. Objects GitHub already has are skipped by GitHub's batch API.
`desolate --review` (and the panel's Review & Push) marks LFS files with their
real size: `A  assets/model.bin  (LFS, 118 MiB: uploaded with the push)`.

**Pull.** After origin/* is set, the sandbox lists the LFS files at the tip of
the branch checked out (`git lfs ls-files`, offline) and which of their objects
its store lacks. If it lacks any it says `needs-lfs` and changes nothing more;
the editor then asks for a *download* credential and hands over again (the
branches are not re-sent). The sandbox fetches, then merges **with smudging
off** -- so a missing object can no longer fail the merge half-way -- and
`git lfs checkout` fills in the files whose objects are local. The result says
how it went: `; fetched 2 LFS objects`, or `; its LFS objects could NOT be
fetched ... those files stay pointers until a pull succeeds`. `--fetch-only`
touches no LFS and asks for no credential. A pull that needs no objects asks for
no credential either.

**First checkout** (`repo add`, a new worktree). The sandbox checks out with
smudging off and then runs `git lfs checkout`: LFS files whose objects are local
(a worktree of a project that has fetched them) are real files, the rest are
pointers with a clean `git status`, and the first `desolate --pull` fills them
in.

**Where the objects live.** Only in the project's `.git/lfs` (shared by its
worktrees). The editor keeps nothing: no cache of objects, which could be large,
and an object is stored once, where it is used.

## Not covered, and not measured

Nothing below the unit tests has been run against GitHub from the VM; the first
real push and pull of an LFS file is the check that matters.

- **The sandbox's egress to the three LFS hosts.** Inferred from the sandbox
  being handed the proxy's CA for git-lfs, and from the probe's editor reaching
  all three through the same proxy; not exercised. If the proxy's destination
  allowlist is restricted, add them.
- **The exact shape of GitHub's `href`.** Taken to be
  `https://lfs.github.com/<owner>/<repo>`; `lfsAuthFrom` also accepts a `.git`
  and `/info/lfs` suffix. If GitHub answers otherwise, the push says the endpoint
  was refused, and the fix is that one regular expression.
- **A read-only deploy key** should be refused at upload; untested (Q2 used a
  write key). A pull needs only download.
- **A download longer than ten minutes.** The credential is minted once per
  pull; git-lfs batches in groups, and a later batch after expiry fails. Objects
  already fetched stay in the store, so running the pull again resumes.
- **An object GitHub already has, objects over a few MB, partial failure and
  retry, fork networks** (LFS storage is shared across a fork network; a deploy
  key is for one repository).
- **Quota.** LFS storage and bandwidth are billed to the repository owner; a push
  spends them, which is why it says so first.
- **Pointers with git-lfs extensions** (`ext-N-...` lines, which nothing uses)
  are not recognised: a push would send them as plain text, as it did before.
- **Other LFS servers.** Only GitHub's, because every registration is a
  `github.com` alias. The seam is `lfsServerOf` in `transfer.ts`: a registration
  for another forge would name its LFS host and how it hands out a token; the
  sandbox's scripts are told an endpoint and a header and know nothing about
  GitHub.
- **Suede dependencies** (`deliver`, `suede upstream`) are unchanged: they move a
  `release` branch's git objects and do not fetch or send LFS objects.
- **LFS file locking** is not used.
- **Typing `git lfs pull` in a devcontainer** still cannot authenticate (no key
  there); use `desolate --pull`.

## Trying it for real

Nothing here has run against GitHub yet (see above). To check it, with a
scratch **private** repository (so a public one cannot serve the download
without the credential) that has an LFS file in it:

```bash
# on the Mac, once the stack is up
./cli.sh repo add <you>/lfs-scratch            # registers the deploy key, clones through the cache
./cli.sh desolate <you>/lfs-scratch            # first start: the checkout runs in the sandbox
./cli.sh worktree add <you>/lfs-scratch t1     # a worktree to commit from
./cli.sh desolate <you>/lfs-scratch --worktree t1
```

1. **First checkout.** In the project's devcontainer, `git status` is clean and
   any LFS file is a ~130-byte pointer (`cat` it). That is expected; it is not a
   half-written tree.
2. **Pull fills them in.** `desolate --pull <you>/lfs-scratch` (outer editor
   terminal, the panel, or `./cli.sh pull`). It should end `; fetched N LFS
   object(s)`, and the files are now real. *Needs:* the sandbox reaching the
   three LFS hosts, and GitHub's `href` being the expected shape.
3. **Commit a new LFS file** in the worktree (`git lfs track '*.bin'` once, then
   add a `.bin` and commit). In the devcontainer, `git lfs` stores the object in
   `.git/lfs`.
4. **Review.** `desolate --review --worktree t1 <you>/lfs-scratch` should list it
   as `(LFS, <size>: uploaded with the push)`, with its real size.
5. **Push.** `desolate --push --worktree t1 <you>/lfs-scratch` (or the panel's
   Review & Push). It should print `uploading 1 LFS object (...)` and the file's
   name first, then `pushed t1 ...`. On GitHub, open the file in the web UI: it
   should show "Stored with Git LFS" and download.
6. **Round trip.** In a second worktree (or after `rm`-ing the object from
   `.git/lfs`), `desolate --pull` of that branch brings it back.
7. **Lost object.** Delete an unpushed LFS object from `.git/lfs/objects`, commit
   a pointer to it, push: it must fail naming the object and **not** push the
   branch.

What would tell you which assumption broke:
`refusing it` / `names an endpoint that is not lfs.github.com/...` -- the `href`
shape (one regex, `lfsServerOf` in `transfer.ts`);
a git-lfs connection or TLS error in the sandbox's output -- egress to
`lfs.github.com`, `github-cloud.s3.amazonaws.com`,
`github-cloud.githubusercontent.com` (the proxy's allowlist, or the CA);
`bad_permissions` on upload -- the registered key is read-only.
`./cli.sh proxy audit --project <you>/lfs-scratch` shows which hosts the sandbox
reached.

Delete the scratch repository afterwards (its deploy key goes with it).

## Tests

`tests/unit/desolate/lfs.test.ts` runs the real git-lfs against a stand-in LFS
server (`tests/unit/fixtures/lfs-server.ts`) through the sandbox scripts as the
runner runs them, with a project whose config, committed `.lfsconfig`,
`insteadOf`, proxy and credential helper all point at a second server: it must
see no request, the credential must reach only the batch endpoint, the project's
`core.fsmonitor` must not run, and the branch must reach the remote only after
the objects. It also covers a lost object (the branch is not pushed), the pull
paths (objects fetched, fast-forward over new LFS files, GitHub missing an
object, nothing needed, `--fetch-only`), and the strictness of pointer and
credential parsing. `review.test.ts` covers the `lfs` kind. The same tests were
also run in an Alpine container (busybox `sh` and `awk`, git 2.54.0, git-lfs
3.7.1 -- the sandbox image's versions), since the scripts run under busybox
there. They are skipped where there is no git-lfs.
