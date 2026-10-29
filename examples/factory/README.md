# examples/factory: software factories built on desolate

desolate itself only provides isolated development environments, plus a few primitives an outside script can drive (`docs/agents.md`). Everything in this folder is such a script: it runs on your Mac, uses your `gh`, and could be replaced by your own.

## Who does what

| Layer | What it does | What it never does |
| --- | --- | --- |
| **desolate** (the stack) | isolated devcontainers and worktrees; pushes and pulls with your deploy keys (`desolate --push/--pull`); the status each agent sets (`/desolate/status`); the three suede primitives (`./cli.sh suede`) | decide anything about issues, PRs or agents |
| **`lib/gh-dispatch.sh`** (the dispatch loop) | turns GitHub issues labelled `desolate:run` into worktrees with an agent in each; relays the agent's status (comments on orange/red, asks you to push on green, opens the draft PR); removes the worktree when the issue closes | write code, push, or merge |
| **`claude/claude-helper.sh`** (the agent driver) | Claude Code in a tmux session in a worktree, on your subscription token; installs tmux, claude and git-subrepo when missing; turns Claude's own events into statuses | choose what to work on |
| **the Claude agent** (inside the devcontainer) | reads the issue, works, commits, sets its status, coordinates through `board` and `note` | push, merge, or reach GitHub: it has no credentials |
| **`suede/suede-factory.sh`** (the suede connector) | watches the stack's projects for changes to suede dependencies, proposes them upstream, files the review and sync issues, links and replaces PRs | start agents (it files issues, the dispatcher starts the agents), push agent work, or merge |
| **you** | review, push (the panel's Push), merge; approve a new dependency joining the stack | |

The two scripts you run, `claude/claude-dispatcher.sh --all` and `suede/suede-factory.sh run`, never call each other. **GitHub issues are the contract between them**: the factory files an issue, and the dispatcher picks it up.

## How they connect

```mermaid
flowchart TB
  you(("you"))
  subgraph mac["Your Mac: your gh, your terminal"]
    sf["suede/suede-factory.sh<br/>proposes upstream,<br/>files review and sync issues"]
    subgraph dispatcher["claude/claude-dispatcher.sh --all"]
      loop["lib/gh-dispatch.sh<br/>issue to worktree to agent to PR"]
      helper["claude/claude-helper.sh<br/>Claude in tmux, on your token"]
    end
  end
  subgraph github["GitHub"]
    issues["issues<br/>label desolate:run + hidden marker"]
    prs["branches and PRs"]
  end
  subgraph stack["desolate stack (Colima VM)"]
    editor["outer editor<br/>deploy keys and caches:<br/>push, pull, suede deliver and upstream"]
    sandbox["sandboxes<br/>one project each, no network:<br/>suede report, worktree add"]
    subgraph dc["a worktree's devcontainer"]
      agent["Claude agent<br/>commits, /desolate/status"]
    end
  end
  sf -->|"gh: file and close issues, edit PR text"| issues
  sf -->|"cli.sh suede report, deliver, upstream"| stack
  loop -->|"gh: read issues, comment, open draft PRs"| issues
  loop -->|"cli.sh worktree add, desolate, pull"| stack
  loop --> helper
  helper -->|"cli.sh exec"| agent
  agent -.->|"status: green, orange, red, gray"| loop
  editor -->|"git push, deploy key"| prs
  you -->|"review, Push, merge"| prs
  you -->|"approve a dependency"| sf
```

## The life of one issue

The same steps for any issue labelled `desolate:run`, whether you wrote it or the suede factory did:

```mermaid
sequenceDiagram
  participant I as GitHub issue (desolate:run)
  participant L as gh-dispatch loop
  participant S as desolate
  participant H as claude-helper
  participant A as Claude agent
  actor You
  L->>I: list open issues (every project, every tick)
  L->>S: worktree add, on the marker's branch or issue/N
  L->>S: start its devcontainer
  L->>H: start an agent with the issue as its task
  H->>A: claude in tmux, in the worktree
  A->>A: work, commit, /desolate/status set blue
  A-->>L: status orange (a question)
  L->>I: comment the question
  You->>A: answer it (claude-helper attach)
  A-->>L: status green
  L->>You: review it, then push
  You->>S: Push (panel), or desolate --push
  L->>I: draft PR that closes the issue, or none if the marker names a PR
  You->>I: merge, and the issue closes
  L->>S: stop and remove the worktree
```

## The contract: labels and markers

**`desolate:run`** on an issue means an agent should work on it. The dispatcher reads only that label.

An issue can also carry a **hidden marker** with details its number can't express. The suede factory writes these; the dispatcher reads them (`lib/gh-dispatch.sh`):

```html
<!-- desolate-dispatch: {"branch":"downstream/acme/app-5e0c…","start":"origin/downstream/acme/app-5e0c…","fetch":true,"pr":12} -->
```

| Field | Meaning | Without it |
| --- | --- | --- |
| `branch` | the worktree's branch | `issue/<n>` |
| `start` | where a new branch starts | the project's checked-out branch |
| `fetch` | refresh the project's `origin/*` first (`pull --fetch-only`) | no refresh |
| `pr` | the branch already has this PR: on green you're asked to push to it, and no new PR is opened | a draft PR is opened |
| `base` | the base of the PR it opens | the repository's default branch |

The suede factory keeps its own state in a second marker, `<!-- suede-factory: {...} -->`: which consumer and folder, the change's fingerprint, and the PR. That lets it restart from GitHub alone. The suede-specific labels, `suede:upstream` and `suede:sync`, are for your filtering; the dispatcher ignores them.

**Statuses** an agent sets with `/desolate/status`, as the dispatcher reads them:
- **blue:** working;
- **orange:** a question for you, commented on the issue;
- **red:** stuck;
- **green:** ready, so you're asked to push;
- **gray:** withdrawn: it recommends not merging, which is said on the issue and its PR.

## What's here

```text
examples/factory/
├── README.md                    this page
├── lib/gh-dispatch.sh           the dispatch loop (sourced by the dispatchers)
├── gh-dispatcher.sh             the loop, with any agent command (FACTORY_AGENT)
├── claude/
│   ├── claude-dispatcher.sh     the loop, with Claude via claude-helper
│   └── claude-helper.sh         Claude Code in a worktree: auth, start, resume, attach, verify
└── suede/
    └── suede-factory.sh         suede upstreaming and syncing (docs/suede-factory.md)
```

## Running it

```bash
# once: Claude's subscription token, stored in the VM, used only in the Authorization header
examples/factory/claude/claude-helper.sh auth <any project>

# any issue you label desolate:run, in any project in the stack
examples/factory/claude/claude-dispatcher.sh --all                  # --max-agents 3 by default

# plus, for suede dependencies
examples/factory/suede/suede-factory.sh run --dry-run --once        # first, see what it would do
examples/factory/suede/suede-factory.sh run
examples/factory/suede/suede-factory.sh sync acme/app               # ask for syncs by hand
```

More: `docs/agents.md` (desolate's primitives), `docs/suede-factory.md` (the suede side, with examples).
