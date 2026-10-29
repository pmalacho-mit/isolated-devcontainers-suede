# The suede factory

When a project in the stack changes one of its [suede](https://github.com/pmalacho-mit/suede) dependencies, those changes are proposed back to the dependency automatically. An agent then decides whether and how to integrate them. When the dependency releases, every consumer in the stack is synced to the new release by an agent. Pushes and merges stay yours.

It is three parts, each doing one job:

| Part | Its job |
| --- | --- |
| **desolate** | isolated environments, plus three narrow primitives for suede dependencies (below) |
| **`examples/factory/claude/claude-dispatcher.sh --all`** | starts a Claude agent, in a desolate worktree, for each issue labelled `desolate:run` in any project in the stack |
| **`examples/factory/suede/suede-factory.sh run`** | connects them: proposes changes upstream, files the issues the agents work on, links and replaces PRs. It never starts an agent itself. |

Run the last two on your Mac. They talk only through GitHub issues: a label, plus a hidden marker in the body.

```bash
examples/factory/claude/claude-dispatcher.sh --all            # agents for every desolate:run issue (--max-agents 3)
examples/factory/suede/suede-factory.sh run --dry-run --once   # first: what it would do
examples/factory/suede/suede-factory.sh run                    # then: every 60 s
examples/factory/suede/suede-factory.sh status                 # what it is waiting on
examples/factory/suede/suede-factory.sh sync acme/app          # ask for syncs by hand (below)
```

## What counts as a suede dependency

A subrepo whose `.gitrepo` tracks `branch = release`. Two kinds of subrepo are excluded:
- the project's own `release/`;
- suede's tooling subrepos (`.suede/core`, the workflows), which track `dependency/...` branches.

**A nested dependency is its own.** A change under `outer/inner/` is proposed to `inner`'s repository, not to `outer`'s. It reaches `outer` later: `outer` syncs its vendored copy when `inner` releases, then releases itself, and then you sync `outer`.

**How a consumer uses a dependency** sets how pressing the work is:

| Kind | When | What the agent is told |
| --- | --- | --- |
| `release` | the consumer is itself a suede dependency, and a root symlink `<name><sep><repo>` declares it | **Blocking:** the consumer cannot publish until this lands and it syncs. Integrate it, adapting where needed. |
| `vendored` | it lives inside the consumer's `release/` | the consumer ships a fork as source; integrating it lets it drop the fork |
| `development` | anything else, in a consumer that is a suede dependency | useful to the consumer, and maybe to others; the agent decides, and "don't merge" is a fine answer |
| `app` | the consumer is not a suede dependency | the same as `development` |

## The flow

Each tick of `suede-factory.sh`:

1. **A consumer's `main` moved.** The factory:
   - refreshes `origin/*` (`cli.sh pull --fetch-only`);
   - reports its suede dependencies at `origin/<main>` (`cli.sh deps report`);
   - delivers the history of any it lacks (`cli.sh deps deliver`). A dependency that isn't in the stack is asked about once, by notification: `suede-factory.sh approve <owner/repo>` adds it, with `cli.sh repo add`, which clones it and creates a write deploy key on it.
2. **A dependency differs from its pin.** Unless that exact change is already proposed, compared by `git patch-id`, `cli.sh deps upstream` pushes it to the dependency as `downstream/<consumer>-<commit>`. That is suede's own branch, so suede's own workflow there opens the PR into `main`.
3. **That PR appeared.** The factory files an issue in the dependency, labelled `desolate:run` and `suede:upstream`, and edits the PR to `Closes #<issue>`. The issue holds:
   - the task, framed by kind;
   - the files, and the PR's own text;
   - every other open proposal into the dependency;
   - a marker telling the dispatcher to start the worktree on the PR's branch.

   The consumer keeps one open proposal per dependency folder. A newer change replaces the older one: the older PR and issue are closed, their branches kept, and the commits that had been added there are listed in the new issue for the agent to carry over.
4. **The agent works.** It runs in a worktree of the dependency, on the PR's branch. Other agents working on proposals into the same dependency are in the same repository, and coordinate through `/desolate/status board` and `note`. One can carry another's change; the one that hands its change over finishes `gray "withdrawn: …"`. When an agent finishes:
   - **green:** you're asked to review it and push it to the PR (the panel's Push, or `desolate --push --worktree <name> <project>`), then merge it;
   - **gray:** withdrawn; it's said on the issue and the PR.
5. **The dependency released**, i.e. its `release` branch moved, which happens after a merge publishes. Two kinds of consumer get a sync issue, `suede:sync`, release dependencies first:
   - **proposers:** consumers whose proposal was merged into this release. Their issue was closed as completed, and its PR is merged.
   - **blocked consumers:** those that ship the dependency as a release dependency while their copy still differs from its pin. They can't publish until they sync, even when their change was carried into someone else's PR.

   Nobody else is synced automatically; use `sync` for that, below. The release is delivered beforehand, and the issue spells out the offline sync:

   ```bash
   GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0="url.$bundle.insteadOf" GIT_CONFIG_VALUE_0="$remote" bash <dir>/.suede/core/sync
   ```

   That runs suede's `sync` (`git subrepo pull`) against the delivered release, and `.gitrepo` keeps the real remote. On green you push, and the dispatcher opens a draft PR.

**What stays yours:** every push of an agent's work, every merge, and adding a dependency to the stack.

**What it does by itself:**
- it pushes `downstream/*` branches, whose content is already on a consumer's `main`, which you merged;
- it files and closes issues;
- it adds labels;
- it edits PR descriptions;
- it closes PRs a newer proposal replaces.

`--dry-run` does none of that. It says what it would do, and records nothing as done.

## Who syncs, and when

**On a release** (`run --sync <mode>`):
- **`proposers`, the default:** the consumers whose proposal was merged into it, plus those blocked on it, as in step 5. The work in flight stays easy to follow: only consumers already involved in this change get an agent.
- **`all`:** every consumer in the stack whose pin is behind.
- **`none`:** nothing on a release; only `sync` by hand.

**By hand, whenever you choose,** through the same issues, labels and agents:

```bash
examples/factory/suede/suede-factory.sh sync acme/app --dep acme/widget            # one consumer, one dependency
examples/factory/suede/suede-factory.sh sync acme/app                              # one consumer, all its dependencies
examples/factory/suede/suede-factory.sh sync acme/app acme/lib --dep acme/widget   # several consumers, one dependency
examples/factory/suede/suede-factory.sh sync acme/app acme/lib                     # several consumers, everything
examples/factory/suede/suede-factory.sh sync --all --dep acme/widget               # every project in the stack, one dependency
examples/factory/suede/suede-factory.sh sync --all                                 # every project, everything
```

`--dep` repeats. Each consumer named is looked at now, at its `origin/<main>`, and each of its suede dependencies (or only those `--dep` names) whose pin is behind its release gets a sync issue. An open sync for the same folder isn't filed twice. `--dry-run` says what it would file.

Every mode is bounded by the dispatcher's `--max-agents` (default 3): the rest wait their turn.

**Not built:** debounce, i.e. waiting N minutes after a release so several releases batch into one sync per consumer.

A dependency's first release seen is recorded, not acted on. Syncs follow the releases after that.

## desolate's part

Three `cli.sh` commands. They aren't offered in the editor's `desolate` or its panel, the dependency is always named by the caller and never read from project content, and devcontainers can't reach any of them.

| Command | Where it runs | What it does |
| --- | --- | --- |
| `deps deliver <project> <owner/repo>` | editor | the dependency's `release` branch, from its push/pull cache, into `<project>/.git/desolate-dep-<owner>__<repo>.bundle` |
| `deps report <project> [--ref R]` | the project's sandbox | its suede dependencies at R: kind, pin, changed files, patch-id |
| `deps upstream <project> <dir> [--ref R]` | sandbox, then editor | one commit on the pin, containing the folder without its `.gitrepo` and nested subrepos, pushed to a new `downstream/*` branch with the dependency's key |

**Why "the Mac's alone" is only partly enforceable.** The editor already holds every key and cache, so a compromised editor could do by hand what these commands do. What protects you is the narrow scope, and that devcontainers have no channel to desolate at all. A real gate would mean moving keyring access out of the editor.

**What makes it work.**
- **The upstream push:** suede's dependency workflow rebuilds a submission from `merge-base(release, submission)`, so one commit on the pin is all it needs. No git-subrepo or network is needed in the sandbox. Measured: suede's own `rebuild-pr-branch.sh` accepts it.
- **The offline sync:** measured, `git -c url.<bundle>.insteadOf=<remote> subrepo pull` pulls offline and leaves `.gitrepo` alone. Don't use `subrepo pull -r <bundle>` for this: it writes the bundle path into `.gitrepo`.

**Also added:**
- `desolate --pull --fetch-only`;
- `/desolate/status note` and `board`, explained in `AGENTS.md`;
- claude-helper installs git-subrepo 0.4.9 for the session when a container lacks it.

## Not yet run for real

Everything above is tested with real git and git-subrepo, but against local remotes and stand-in `gh`/`cli.sh` (`tests/unit/desolate/deps.test.ts`, `tests/static/15-dispatcher.sh`, `tests/static/16-suede-factory.sh`). Not yet seen:
- suede's workflow opening the PR on GitHub, from a branch desolate pushed;
- an agent's sync in a real devcontainer;
- the whole loop on real repositories.

**To try it:**
1. Make two throwaway suede dependencies with suede's `scripts/create/dependency.sh`, e.g. `widget`, plus a consumer that installs `widget`.
2. `./cli.sh repo add` all three.
3. Change `widget`'s folder in the consumer, and merge to its `main`.
4. Run the factory with `--dry-run --once`, then for real, alongside `claude-dispatcher.sh --all`.
