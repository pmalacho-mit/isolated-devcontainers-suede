- adopt examples of other projects (like devvm, microsandbox) to embrace a vm per workspace (instead of a cluster of containers + relays + volumes)
  - why: vm's are built for isolate, containers needed sysbox as a layer to add isolation
  - why: vm's will enable per vm proxy, enabling more control
- embrace the concept of a 'permissions group' (or maybe 'resource group'), where the resources are:
  - a read or read/write github deploy key for one or more repo(s)
  - shared access to one or repo's .git folders
  - maybe these end up being called clusters?
 
- agentic isolated development for a single repo:
  - clone of /<user>/<repo> with a .git folder that can be shared across multiple VM's (via worktrees at .worktrees/) and a pull-only github SSH key
  - when starting a worktree should specific base (e.g. `main` or `origin/main` and related maybe need a way to say `fetch:origin/main` or someway to indicate that we want to get the latest from origin/main)

- isolated development for upstreaming changes to a suede dependency:
  - clone of /<user>/<repo> of consumer repo with a push key of the dependency
 
- single vm acts as the 'desolate root vm' which manages a record of all repos cloned into the stack and has push/pull keys for all repos. Effectively this is where a user does
