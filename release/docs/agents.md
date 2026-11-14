# Agents: running them, watching them, and the factories

## An agent, kept running: `desolate agent`

```bash
desolate agent start acme/agent-1 --name claude -- claude         # any command: it runs in the devcontainer
desolate agent list                                               # every agent, in every workspace
desolate agent attach acme/agent-1 --name claude                  # your terminal on it; Ctrl-] detaches
desolate agent log acme/agent-1 --name claude                     # what it printed (its last 2 MiB)
desolate agent stop acme/agent-1 --name claude                    # interrupts it, as you would
```

The agent runs inside its workspace (in the project's devcontainer, in the checkout you name
with `--checkout`, else the first), under a small holder that keeps its terminal
(`workspace/agent-holder.py`). It runs whether or not anyone is attached, and survives your
terminal closing.

**No tmux, on purpose.** tmux draws the screen itself, so scrolling and copying are tmux's:
its mouse mode gives you one and takes the other. `desolate agent attach` streams the
agent's terminal straight to yours, after replaying what it printed recently, so your
terminal's own scrollback, selection and copy work as for anything else. Ctrl-] lets go
(and puts back what the agent changed of your terminal's modes); Ctrl-C goes to the agent.
Many people can attach at once. What the agent prints reaches your terminal filtered: what
a full-screen program needs passes, and the escape sequences that act beyond the screen
(the clipboard, files, window operations, concealed text) do not.

**In parallel.** One workspace is one VM, and agents in different workspaces run truly side
by side (a workspace can hold more than one, by `--name`). A workspace from its domain's
template starts in about 20 s. `desolate agent list` shows each agent's state and when it
last printed anything; the dashboard shows each workspace's status as the agent sets it
(`desolate status set ...` inside), and `desolate notify` turns orange and red into
notifications.

## Claude agents, start to finish

What you run, once and then per task. Everything below runs on your Mac.

**Once, for the stack** (a Pro, Max, Team or Enterprise subscription):

```bash
claude setup-token        # Claude Code on your Mac prints a long-lived token
desolate clone you/app    # the repository, and a domain named after it: app
desolate domain app secret set CLAUDE-OAUTH --hosts api.anthropic.com --headers authorization
                          # paste the token; it is held in the root VM, never in a workspace
```

**Each task:**

```bash
desolate task app "Fix the login redirect loop, with a test"      # --attach to watch at once
```

That makes a workspace named for the task (`fix-the-login-redirect-loop`), with every
repository of the domain on `task/<that name>`, starts Claude Code in it on your sentence plus
desolate's standing orders, and keeps it running whether or not you watch:

- **Watch or talk to it:** `desolate agent attach app/fix-the-login-redirect-loop` (Ctrl-]
  lets go; it keeps working). Your terminal's own scrollback and copy work.
- **Hear from it:** `desolate notify` turns its statuses into notifications: orange when it
  asks you something, green when it has offered its branch.
- **Review and push:** `desolate ui --open`. Its branch is under Branches as it commits, and
  under Needs you once it is offered; Review shows the commits and the diff, and Push asks you
  to approve the exact commit. Nothing it does reaches GitHub without that.
- **Several at once:** each `desolate task` is its own VM; run as many as your Mac holds
  (`desolate bootstrap` says what one costs).
- **Done with it:** `desolate rm app/fix-the-login-redirect-loop` (its branch stays).

**Another repository:** `desolate clone you/other`, then `desolate task other "..."`. The
first task in a domain without the token copies it from a domain that has it, inside the root
(the value goes nowhere else), and says so; `desolate domain other secret rm CLAUDE-OAUTH`
undoes that. Two repositories one task should see together go in one domain:
`desolate clone you/lib --domain app`.

**What desolate does for Claude, and why:**

- **The token stays out of the workspace.** The agent's environment holds
  `CLAUDE_CODE_OAUTH_TOKEN=CLAUDE-OAUTH`, a name; the workspace's proxy writes the token into
  the `Authorization` header of requests to api.anthropic.com, and nowhere else. A workspace
  that leaks its environment leaks a name.
- **Installed once per domain.** When the project's devcontainer has no Claude Code, desolate
  installs it into the domain's cache (`/desolate/cache/claude-code`), which every workspace of
  the domain mounts and a container rebuild keeps. To carry it in the image instead, add the
  devcontainer feature `ghcr.io/anthropics/devcontainer-features/claude-code:1`.
- **Its first-run questions are answered** (the theme picker, trusting the folder), so an
  agent started with nobody attached gets to its task instead of waiting at the first prompt.
- **Auto mode** (`--permission-mode auto`): Claude handles its own permission prompts, checking
  each action first. The workspace VM is the boundary either way: no keys, a proxied network,
  and pushes only through you.
- **The standing orders** tell it where it is (`/desolate/release/AGENTS.md`), to commit as
  it goes, to `desolate offer` and go green when done, and to go orange and wait when it
  needs you.

**Without `desolate task`**, the same by hand (a workspace you already have, a name of your
choosing):

```bash
desolate agent start app/w1 --name claude -- \
  env CLAUDE_CODE_OAUTH_TOKEN=CLAUDE-OAUTH claude --permission-mode auto "Fix issue #12: ..."
```

Here Claude must already be in the environment, and its first run asks its questions:
`desolate agent attach` and answer them. Your own agent instead of Claude: `desolate task app
"..." -- <command...>`, which gets the task as its last argument. With an API key instead of a
subscription: a secret on the header `x-api-key`, and `ANTHROPIC_API_KEY=<its name>`.

**What has not been tried:** a real subscription token. The path has been run end to end on
the M1 with a stand-in token: the secret copied between domains, Claude installed and started
on its task, the token substituted on the way to api.anthropic.com, and Anthropic answering
that the token is invalid, as it should for a stand-in. Your first `desolate task` is the
first with a real one; if it says `Please run /login`, the token is wrong or expired: run
`claude setup-token` again and `secret set` it again.

## The issue factory: `desolate factory issues`

```bash
desolate factory issues --repo you/app --domain acme --max 3
```

On your Mac, with your `gh`: every open issue labelled `desolate:run` (`--label`) becomes a
workspace `issue-<n>` with a worktree on `issue/<n>` and Claude in it, the issue as its task;
at most `--max` at once, started side by side. It prints what each agent says as it says it.
When you push `issue/<n>` (the git terminal, or the dashboard's Push), it opens a draft pull
request titled `Issue #<n>` that closes the issue; nothing an agent wrote, and nothing an
issue's author could change after the label went on, is posted under your login. When the
issue is closed, its agent is stopped and its workspace removed (the branch stays). Any other
agent: `-- <command...>`, which gets the task as its last argument.

## The suede factory: `desolate factory suede`

```bash
desolate factory suede                                   # listens; Ctrl-C stops
desolate factory suede --commit you/app@<commit>          # one push, after the fact
```

It listens for pushes to a repository's default branch (the pusher announces each). For
each, the root works out which vendored suede dependencies the push changed: every directory
with a `.gitrepo` (suede's record of where a dependency came from), the files under it the
push touched, a nested dependency's files counted as its own; the project's own `release/` is
not a dependency. No agent is involved in that.

Which repositories share a domain is yours to decide, never a commit's: set the domain up
once, with each project and the dependencies you upstream to,

```bash
desolate domain create suede --repo you/app --repo you/some-dependency
```

and the factory works only on dependencies the domain already holds (it says what to run for
any other: a `.gitrepo` in a pushed commit could name any repository desolate holds). For each
changed one, it makes a workspace in the domain `suede` (`--domain`), with the dependency on
`upstream/<project>-<commit>` and the project beside it, and an agent whose task names the
directory, the commits and the dependency's layout (its release branch is its main branch's
`release/`). The agent decides: if the change belongs upstream it makes it on its branch,
runs the dependency's tests, offers it and goes green; if not, it goes gray and says why.

The push upstream is yours, never the agent's: review the branch in the dashboard and push
it. When the branch is pushed, the factory opens a pull request to the dependency.

When you already know a consumer branch's change to a dependency should go upstream, no agent
is needed: `desolate upstream` splits it out with suede's own upstream and proposes it as
suede's `downstream/...` branch, which the dependency's own Action turns into a pull request.
[suede.md](suede.md) has both, side by side.
