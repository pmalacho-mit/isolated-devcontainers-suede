# git-guard.bash -- the outer editor's interactive shells: no git in a project.
#
# git in a project is that project's own git. It runs the repository's hooks
# (pre-push, post-merge, post-checkout), obeys its config (core.fsmonitor runs
# on `git status`, core.sshCommand on a push, a pager on `git log`), and follows
# its refs wherever they point. And this is the one container that can write
# every project and use every deploy key (README, "project <-> editor"). So
# here, typed git that would act on /workspaces/* is refused:
#
#   review and commit   in the project's own devcontainer
#   push and pull       desolate --push|--pull [--worktree <name>] <project>,
#                       or the desolate panel's buttons (transfer.ts)
#
# A guard for what is typed, not a boundary: desolate's own git never comes
# through here (it is not an interactive shell), and `command git ...` is the
# way past it on purpose.
git() {
  local dir=$PWD skip="" arg
  for arg in "$@"; do
    case "$skip" in
      dir) case "$arg" in /*) dir=$arg ;; *) dir=$dir/$arg ;; esac; skip=""; continue ;;
      one) skip=""; continue ;;
    esac
    case "$arg" in
      -C) skip=dir ;;
      --git-dir | --work-tree) skip=dir ;;
      --git-dir=* | --work-tree=*) dir=${arg#*=} ;;
      -c | --namespace | --exec-path | --config-env) skip=one ;;
      -*) ;;
      *) break ;;   # the subcommand: what follows is its own
    esac
  done
  [ -z "${GIT_DIR:-}" ] || dir=$GIT_DIR
  local real
  real=$(cd "$dir" 2>/dev/null && pwd -P) || real=$dir
  case "$real/" in
    /workspaces/*)
      cat >&2 <<'SAID'
desolate: no git in a project from the outer editor -- it would be that
          project's own git (its hooks, its config), with every deploy key in reach.
  review and commit:  in the project's own devcontainer
  push and pull:      desolate --push|--pull [--worktree <name>] <project>
                      (or the desolate panel's buttons)
  if you mean it:     command git ...
SAID
      return 1 ;;
  esac
  command git "$@"
}
