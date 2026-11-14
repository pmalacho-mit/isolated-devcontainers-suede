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

## Claude Code in a workspace

Its credential stays out of the workspace. Once per domain, on your Mac:

```bash
claude setup-token                       # prints a subscription token (Pro, Max, Team or Enterprise)
desolate domain acme secret set CLAUDE-OAUTH --hosts api.anthropic.com --headers authorization
                                         # paste the token on stdin
```

The workspace holds the name `CLAUDE-OAUTH`; its proxy puts the token in the
`Authorization` header of requests to api.anthropic.com, and nowhere else. Then:

```bash
desolate agent start acme/agent-1 --name claude -- \
  env CLAUDE_CODE_OAUTH_TOKEN=CLAUDE-OAUTH claude --permission-mode auto "Fix issue #12: ..."
```

Claude Code must be installed in the project's environment: the devcontainer feature
`ghcr.io/anthropics/devcontainer-features/claude-code:1` does it (the factory installs it
with npm when it is missing, which a rebuild of the container loses). With an API key instead:
a secret on the header `x-api-key`, and `ANTHROPIC_API_KEY=<its name>`.

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
