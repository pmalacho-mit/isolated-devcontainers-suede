# suede dependencies: changing one in a consumer, and proposing the change upstream

[suede](https://github.com/pmalacho-mit/suede) vendors a dependency into a consumer with
git-subrepo: the dependency's `release` branch is copied into a directory, with a `.gitrepo`
that says where it came from. Agents working in the consumer change those files like any
others. This page is how such a change goes back to the dependency through desolate, with
you deciding, and nothing pushed that you did not approve.

There are two ways, for two situations:

| | `desolate upstream` | `desolate factory suede` |
|---|---|---|
| You start from | a consumer branch you have read and want proposed | a push to a consumer's default branch |
| Who ports the change | nobody: suede's own split, mechanical | an agent, in the dependency's own checkout |
| The branch it makes | `downstream/<owner>/<consumer>-<commit>` (suede's) | `upstream/<consumer>-<commit>` |
| The pull request | the dependency's own `suede-downstream-to-main` Action opens it | the factory opens it with your `gh` |
| Needs | the dependency cloned (pushable) | a domain holding the consumer and the dependency |

Both end in an ordinary push: the approval page names the dependency, the branch and the
commit, and only then does the pusher send it.

## Setting up, once

```bash
desolate clone you/some-dependency                 # pushable: proposals go to it
desolate clone you/app --no-push                   # the consumer: never written through desolate
desolate domain create app --repo you/app          # where agents work on the consumer
```

The dependency must have suede's downstream Action on its `release` branch (every dependency
made from suede's template has it), so that a `downstream/...` branch becomes a pull request.

## `desolate upstream`: a change you have decided on

An agent changed `some-dependency/` in a workspace and committed it on `fix/thing` (offered or
not: every branch reaches the root as it is written). Read it (the dashboard's Branches, or
`desolate review app you/app fix/thing --diff`), then, on the Mac:

```bash
desolate upstream you/app some-dependency you/some-dependency --from app/fix/thing
```

or in the git terminal (`desolate git you/app --open`), where it is the same command:

```bash
git fetch app && git checkout app/fix/thing
desolate upstream some-dependency you/some-dependency
```

What happens, in the git VM (no network, no keys):

1. **Checks that need nothing run.** The dependency you named must be the one
   `some-dependency/.gitrepo` names (a `.gitrepo` is the branch's content: it does not get to
   choose where a push goes), desolate must hold it, and on the Mac it must be pushable. Every
   `.gitrepo` git-subrepo will read in the history must hold full commit ids. The release commit
   it names must be one the dependency's remote has. The branch must not change the
   dependency's `.github/`: a pushed branch's own workflows run on the dependency's remote, with
   its secrets, the moment it lands, so proposals leave `.github/` alone. And this exact commit
   must not have been proposed already.
2. **suede's own upstream runs**: desolate's pinned copy of it (`release/git/suede-upstream.sh`,
   checked against `SUEDE_UPSTREAM_SHA256` in `pins.env`), with the image's pinned git-subrepo,
   in a scratch clone. Its push is caught there, not sent. **The copy the branch vendors at
   `some-dependency/.suede/core/upstream` is never run**: an agent could have written it.
3. **What it made is checked and shown**: its files are exactly the dependency's directory at
   that commit, it builds on that release commit, `.github/` is untouched. You see the commits
   and the files. If the branch changed the vendored `.suede/core/` (suede's own machinery,
   which every consumer of the dependency runs), that is said in red, and again on the approval
   page.
4. **The push**, with `git push` from the git VM: the root checks every object, the reviewer
   works out what it sends, and the approval page shows it. Approve, and the pusher sends it to
   `downstream/you/app-<commit>`.
5. **The pull request**: the dependency's Action rebuilds the branch onto its `main` and opens
   the pull request. On the Mac, `desolate upstream` waits for it (up to three minutes, through
   GitHub's public API; `GH_TOKEN` lifts the rate limit) and prints its link: a draft if replaying
   the change onto the current release had conflicts, "nothing new" if main already had it, the
   Action's run if it failed. `--no-wait` skips the wait. In the git terminal there is no
   network, so nothing waits: the pull request appears on the dependency.

`--remote <address>` is suede's flag and is accepted only if it names the same repository;
the push goes to the dependency you named either way.

Exit codes: 0 proposed (a pull request is open, or there was nothing new), 1 refused or failed,
2 pushed but no pull request within the wait, 64 usage.

## `desolate factory suede`: should any of this go upstream?

When a consumer's default branch is pushed, the factory works out which vendored dependencies
the push changed and, for each that the domain `suede` holds, starts an agent in a workspace
with the dependency checked out on `upstream/<consumer>-<commit>`. The agent decides whether
the change belongs upstream, makes it in the dependency's own layout (under `release/` on
`main`), runs its tests and offers the branch. You push it (the approval page, as always), and
the factory opens the pull request. See [agents.md](agents.md#the-suede-factory-desolate-factory-suede).

## What not to do

- **Never run `<dependency>/.suede/core/upstream` yourself** in the git terminal (or on the Mac,
  in a clone of agent work). It is a file on an agent's branch, and it fetches and runs a script
  from the network. `desolate upstream` is the same thing, from a copy desolate pins.
- Do not move `SUEDE_COMMIT` by hand: `tools/pin-suede.sh <commit>` fetches suede's
  `scripts/upstream.sh` at that commit and pins its hash; read its diff before committing it.

## Where it is

`release/git/upstream.ts` (the command, in the git VM), `release/host/upstream.ts` (on the Mac,
and the wait), `release/shared/suede.ts` (suede's names; the `.github/` rule the root applies
to every `downstream/...` push), `release/git/suede-upstream.sh` (suede's, pinned). The
reasons are in [`docs/v3/decisions.md`](https://github.com/pmalacho-mit/isolated-devcontainers-suede/blob/main/docs/v3/decisions.md),
"`desolate upstream`".
