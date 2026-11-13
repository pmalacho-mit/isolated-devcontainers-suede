# [Suede](https://github.com/pmalacho-mit/suede) Core (`release`)

Vendored at `.suede/core` on your dependency's **`release`** branch — which
means it ships, and a consumer who installs your dependency finds these at
`<dependency>/.suede/core/`. They are the tools for working with an installed
dependency.

The maintainer's half (the publish guard, `vendor`, the project-wide divergence
audit and the installer itself) is vendored from `dependency/main/core` onto
`main`, at the same path.

This folder is a [git-subrepo](https://github.com/ingydotnet/git-subrepo) of the
suede library, so you get fixes by pulling. **From `main`**, where it lives at
`release/.suede/core` — like everything else that ships, it reaches the
`release` branch through `main`, and there is never a reason to check `release`
out:

```bash
git subrepo pull release/.suede/core
```

That leaves two things behind which stop the next `git subrepo push release`: a
branch `subrepo/release/%2esuede/core` (refs are directories, so `subrepo/release`
becomes uncreatable) and a scratch directory under `.git/tmp/subrepo/release`
(where the push wants its worktree). `push-release.sh` clears both on every
publish, so CI is fine; if you publish by hand, clear them yourself first:

```bash
git subrepo clean release/.suede/core && rm -rf .git/tmp/subrepo
```

## [upstream](./upstream)

Propose this dependency's **local changes back to the library**, as a reviewable
PR against the library's `main`.

Use it when you've edited a vendored dependency in place and want those edits to
become a contribution to the library itself (rather than living only in your repo).

### Usage

```bash
<dependency>/.suede/core/upstream        # if executable
bash <dependency>/.suede/core/upstream   # otherwise
```

First commit the changes you want to send — the working tree must be clean.

### What it does

1. Splits the dependency's local commits out via `git subrepo` and pushes them to
   a deterministic branch on the library's remote:
   `downstream/<owner>/<repo>-<your-commit>`.
2. The library's `suede-downstream-to-main` workflow rebuilds that branch as a
   `main`-shaped PR head and opens the pull request for the maintainers to test,
   fix, and merge.
3. Your local state is restored afterward, so a later `git subrepo pull` stays
   safe. The `release` branch is **never** modified, so other consumers are
   unaffected.

Each commit becomes its own snapshot/branch/PR; re-running on the same commit is a
no-op (it detects the already-open proposal).

### Notes

- It's a thin bootstrapper: the real logic is hosted at `https://suede.sh/upstream`
  so it can evolve without re-shipping dependencies. Override the host (for forks
  or testing) with `SUEDE_UPSTREAM_URL`.
- Requires `git`, `curl`, and [`git-subrepo`](https://github.com/ingydotnet/git-subrepo).
- Pass `-r`/`--remote <name>` to push to a remote other than the one tracked in
  the dependency's `.gitrepo`.

## [sync](./sync)

`git subrepo pull` for **this** dependency, runnable from any working directory.

```bash
<dependency>/.suede/core/sync        # if executable
bash <dependency>/.suede/core/sync
```

Like [`upstream`](./upstream), it takes no target: the dependency it pulls is
the one containing the script. Anything you do pass is handed straight to
`git subrepo pull`, so `sync --force` and the rest of git-subrepo's options
work as documented there.

Two things it does that a bare `git subrepo pull` will not: it runs from the
repository root with a root-relative path, so where you are does not matter; and
it resolves symlinks to the real folder first, because `git subrepo pull`
on a symlink path fails outright — and the edge entries suede creates between
your dependencies are symlinks by default.

`git subrepo pull` also requires a clean working tree, while installing does
not. If you have just installed something, commit before syncing.

## [diff](./diff)

What your copy of this dependency differs from — in either direction.

```bash
bash <dependency>/.suede/core/diff          # what you would propose
bash <dependency>/.suede/core/diff --sync   # what you would receive
```

By default the pinned commit is on the left and your working tree on the right,
so `+` lines are yours: this is the change [`upstream`](#upstream) would
propose. With `--sync` your tree is on the left and the current tip of the
remote's `release` branch on the right, so `+` lines are incoming: this is what
[`sync`](#sync) would bring you. `--sync` also names the two commits, and says
so outright when your pin *is* the tip and a sync would bring nothing.

A sync merges rather than overwrites, so under `--sync` the `-` lines are your
own local work — which a sync keeps, and which is why they are labelled rather
than left to be read as deletions.

Your side is the files as they are on disk: uncommitted edits and files you
have only just created are in, and anything your `.gitignore` excludes is out.
`.gitrepo` is dropped from both sides — it is local bookkeeping and always
differs.

Anything else you pass goes to `git diff`, so `--stat`, `--name-only` and `-w`
work as usual. Exit codes are `0` for no difference and `1` for a difference,
as `git diff` reports them, with `2` reserved for "could not run at all" so a
caller can tell an answer from a failure.

Unlike its neighbours it needs no git-subrepo — just `git` and the ability to
reach the remote.

> The maintainer's side has a `diff.sh` of its own, vendored onto `main`. That
> one audits *every* release dependency of a project against its pin before a
> publish. This one is about the single dependency it ships inside.

## If `git subrepo` is not found

Both scripts need it, and both look in one more place before giving up: if
`GIT_SUBREPO_ROOT` is set, they source `$GIT_SUBREPO_ROOT/.rc` to bring the
command into scope. That covers an install — a devcontainer feature, a login
shell profile — whose `PATH` a non-interactive script never inherited.
