# Git LFS through `--push` and `--pull`: what the probe decided, and what is next

[`tests/probes/lfs-deploy-key.sh`](../tests/probes/lfs-deploy-key.sh) asked
whether a repository's deploy key, over SSH, is enough to move Git LFS objects
for that repository. It was run on 2026-11-05 against a scratch private
repository (issue #51). This page records the answer, what today's code does
with an LFS project, and the plan the answer allows. **Nothing here is built
yet**; the open decisions are at the end.

## The answer

| | question | result |
| --- | --- | --- |
| C0 | the key reaches its repository | yes |
| Q1 | `git-lfs-authenticate <repo> download` | yes -- an href at `lfs.github.com`, valid 599 s |
| Q2 | `git-lfs-authenticate <repo> upload` | yes -- an href at `lfs.github.com`, valid 21599 s |
| C1 | the same key, upload to `octocat/Hello-World` | refused: `bad_permissions ... denied to deploy key` |
| Q3 | an object goes up (65 bytes) | yes: batch 200, PUT to `github-cloud.s3.amazonaws.com` 200, verify at `lfs.github.com` 200 |
| Q4 | the same object comes back | yes: batch 200, GET from `github-cloud.githubusercontent.com` 200, sha256 equals the oid |
| Q5 | pure-SSH LFS (`git-lfs-transfer`) | **no** -- exit 1, "Invalid command" |

So the deploy key `repo add` already registered is enough, and it is scoped
the way the rest of the design needs (C1). The credential question is closed:
no new secret, no token stored anywhere.

Two things the answer fixes about the design:

- **Only the SSH half is SSH.** `git-lfs-authenticate` over the host alias
  yields a short-lived token; the objects then move over HTTPS to three hosts
  -- `lfs.github.com`, `github-cloud.s3.amazonaws.com`,
  `github-cloud.githubusercontent.com` -- from the **editor**, which is where
  the keyring's agent is. The probe ran there (`with-ca`), so the proxy let all
  three through. A sandbox cannot do this: it has no key and no route.
- **Tokens are short.** The download token lasts ten minutes; authenticate
  immediately before each batch, never once per transfer.

## What happens today to a project that uses LFS

Measured with git 2.51 and git-lfs 3.7.1 (the image's pin), by hand, in a
scratch directory -- not through the broker, which needs the VM:

- **Push sends the pointer and never the object.** The sandbox's
  `bundleScript` bundles commits; an LFS file is, in git's object store, a
  130-byte pointer (`version https://git-lfs.github.com/spec/v1` / `oid
  sha256:...` / `size N`). A 3000-byte tracked file made a 453-byte bundle; the
  object stayed in `.git/lfs/objects/`. The editor's `push` runs git with
  `core.hooksPath=/dev/null` and no git-lfs, so nothing uploads it either.
  Inferred, not run against GitHub (no write credentials in a sandbox): the
  branch lands on GitHub with pointers whose objects GitHub does not have,
  and a clone of it cannot materialise those files. **This is the live hazard:
  today the push succeeds and the remote is quietly broken.**
- **Pull cannot check out an LFS file.** `pullScript` ends in `git merge
  --ff-only` in the sandbox, where the image's system filter is
  `filter.lfs.required=true`. With the objects absent and `origin` an ssh
  alias nothing can resolve, the merge failed (`smudge filter lfs failed`, exit
  128) and left the branch where it was. The script maps that to `blocked`,
  which the editor reports as "uncommitted changes in the way?" -- wrong, and
  nothing points at LFS.
- **The first checkout fails the same way.** `repo add` clones with
  `--no-checkout` and the sandbox then checks out. With the objects absent and
  the origin unresolvable, `git checkout main` failed on the LFS file and left
  a half-written tree: `.gitattributes` and `notes.txt` written, `big.bin`
  absent and every path showing as staged-deleted. (README says a failing
  post-checkout hook "fails there with a warning; the files still land" --
  that is not what a failing smudge filter does.) `deliver`, a suede
  dependency's release branch, reaches the same checkout.
- **Given the objects, the sandbox needs no network.** With the object copied
  into the project's `.git/lfs/objects/aa/bb/<oid>`, the same fast-forward
  merge, with `origin` still unreachable, succeeded and produced the exact
  bytes. So the sandbox's half can stay offline; only the editor's half grows.

## The plan

The shape follows the rest of `transfer.ts`: the editor never runs git in a
project and never reads its config; each direction is two halves meeting at
files in the project's own git dir; the project's bytes are only ever opened as
data (`openContained`).

**Do not use the `git-lfs` binary in the editor.** The probe's commit message
records a measurement: a repository's `.lfsconfig` redirects git-lfs to another
repository's ssh alias, even in a bare repository (and a command-line `-c
lfs.url` overrides it). That is
exactly the confusion `cleanGit` exists to prevent. The editor needs three
requests and a sha256, so it speaks the protocol itself: the repository name
comes from the editor's own registration (`Registration.ownerRepo`, from its
own global git config), never from a project, and there is no config to
influence.

### Phase 0 -- stop the silent breakage (small, independent)

- **push:** after the bundle is fetched into the cache, list the blobs the push
  adds (`git rev-list --objects <commit> --not <remote tips>` into `git
  cat-file --batch-check`, keep blobs of at most 1024 bytes, read them, match a
  strict pointer: the exact three lines, `oid sha256:` + 64 hex, `size` + digits).
  Verified to find the pointer and, noisily, `.gitattributes` and other small
  files -- the strict match is what filters. If any pointer is found and
  upload is not yet implemented, **refuse** with the count and the first paths.
- **pull:** map the smudge failure to its own outcome (`lfs-missing`) rather
  than `blocked`, and say what to do.

### Phase 1 -- pull and clone bring the objects down

1. After `refresh`, the editor lists the pointers in the tip tree of the
   branch the target has checked out (what the merge would write) that the
   target lacks. The sandbox says what it lacks, as it already does for commits
   (`.haves`/`needs-full`): a list of oids under `.git/`.
2. For each: `git-lfs-authenticate <ownerRepo> download`, batch, GET, **check
   size and sha256 against the pointer** before keeping it. Write into the
   transfer as `.git/desolate-transfer-<id>.lfs/<oid>`.
3. `pullScript` moves them to `.git/lfs/objects/aa/bb/<oid>` (after re-checking
   the sha256 -- it is the sandbox's own git dir) and then merges as now.
   `repo add` does the same for its first checkout.

### Phase 2 -- push uploads the objects first

1. The editor writes the oids the push needs (Phase 0's list) for the sandbox.
2. The sandbox copies each `.git/lfs/objects/aa/bb/<oid>` it has into the
   transfer. An oid it lacks is named in the failure, and nothing is pushed.
3. The editor verifies size and sha256 per object, then `git-lfs-authenticate
   <ownerRepo> upload`, batch (GitHub answers with no `upload` action for an
   object it already has -- the probe's code handles that case but did not
   hit it), PUT, verify.
4. Only then `git push` of the commit -- objects before the pointers that
   name them, as git-lfs's own pre-push does.

### Rules for the HTTP client (it is the new attack surface)

- Every `href` is `https://` and its host is one of the three above; anything
  else aborts the transfer. A batch response is GitHub's, but it is also data.
- The batch request's token goes to `lfs.github.com` only. An action's own
  `header` goes to that action's href only. Redirects are not followed with
  credentials.
- Cap one object (GitHub's limit is 2 GB) and a transfer's total; stream to a
  file in the editor's cache rather than memory; fail on a size that differs
  from the pointer's, both ways.
- Nothing from a response or a pointer is spliced into a path or a command:
  oids are `^[0-9a-f]{64}$` before they name a file.
- Errors may quote GitHub's message; they never print a token or a header.

## What the probe did not measure

- **A read-only deploy key.** Q2 passed with a write key. A project whose key
  is read-only (a dependency, for `deliver`) should be refused at upload; this
  is untested.
- **An object GitHub already has**, **objects over a few MB**, the lifetime of
  a batch action's own URL (a download of more than ten minutes), partial
  failure and retry, and fork networks (LFS storage is shared across a fork
  network; a deploy key is for one repository).
- **Quota.** LFS storage and bandwidth are billed to the repository's owner. An
  upload spends them. The probe spent 65 bytes.
- **A project with its own LFS server** (`.lfsconfig` with `lfs.url` elsewhere).
  The design ignores `.lfsconfig` by construction, so such objects are fetched
  from GitHub, where they are not; the failure must say so.
- **LFS file locking**, not planned.

## Decisions for a human

1. **Order.** Recommended: Phase 0 first and alone (it removes a live hazard
   and is a few dozen lines), then Phase 1 (read-only, so the lower-risk
   half), then Phase 2. Or all at once.
2. **Upload on every push, or asked for?** Recommended: with the push, but
   `--review` should show an LFS pointer as `lfs: <path> (<size>)` rather than
   as a 130-byte text diff, so the person sees what will be spent before
   pushing. The alternative is an `--lfs` flag.
3. **Keep downloaded objects in the editor's cache?** They make a second
   pull of the same file free, but LFS objects can be large and the cache is
   otherwise bounded to history. Recommended: keep them for the length of the
   transfer only, until there is a measured need.
4. **A non-GitHub LFS server** is refused, not worked around. Say if that is
   wrong for any project you use.
5. **The scratch repository** `pmalacho-mit/desolate-lfs-probe` still exists
   with one object in its LFS storage; the probe asks that it be deleted
   (`gh repo delete pmalacho-mit/desolate-lfs-probe --yes`) once this page has
   what it needs, and its registration removed from the keyring.
