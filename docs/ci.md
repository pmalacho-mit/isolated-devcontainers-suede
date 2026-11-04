# CI and clean-environment tests (issue #31)

**Decision: the stack does not add CI or test-environment features.**

## Why

- **Agents and projects run in devcontainers this stack manages; the stack's own
  test suite is not part of what they get.** What a project's agent should run
  is that project's tests, in that project's devcontainer. The stack cannot know
  what they are, and anything it offered would be a general-purpose runner that
  the project's own `devcontainer.json`, `Dockerfile` or test script already
  does better, since those are specific to the project.
- **A customisable runner is redundant with the devcontainer.** The issue's own
  suspicion holds: if a project wants tests run in a particular setup, it can
  hop into the devcontainer, or define another one, and run its suite there.
  Parameterising on system-level variables is the same: a build arg or a second
  Dockerfile in the project, not a stack feature.
- **The clean-room worry is real but is not the stack's to solve.** A green run
  in an agent's devcontainer can depend on something installed or configured
  there by hand. Only a fresh build, or the project's own hosted CI starting
  from a clean checkout, rules that out. Both belong to the project. A reviewer
  who needs that assurance should look at the project's CI result, or rebuild
  the devcontainer; the stack cannot manufacture it.
- **Other operating systems are out of reach** given the stack (Linux
  containers in a Linux VM). A feature promising macOS or Windows runs would
  promise something it cannot deliver.
- **Cost against benefit.** Any built-in facility adds a surface to maintain
  and, in a stack whose job is containment, a new thing that executes
  project-supplied commands. The benefit would be small, because the project
  can already do all of it.

## Revisit if

A project that uses the stack shows a concrete need the devcontainer cannot
meet, such as a clean-room run that needs stack-managed isolation (the proxy,
secrets scoping). Then it is a feature request with a real user.
