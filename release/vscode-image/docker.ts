/**
 * docker.ts -- every docker invocation desolate makes, as one named operation
 * each.
 *
 * The commands are built here rather than at the call sites for
 * readability and testability.
 */
import type { RunOptions } from "./utils.ts";
import { REVIEWED, REVIEW_LIMITS } from "./review.ts";

/** How a command reaches the world. The two shapes differ in what they return,
 *  not in what they run: `output` is for queries, `status` for effects. */
export interface Runner {
  /** stdout, trimmed. "" when the command failed. */
  output: (argv: string[]) => string;
  /** Exit status; a bound that fires reports as a non-zero one. */
  status: (argv: string[], options?: RunOptions) => number;
  /** Feed `input` on stdin. Returns the failure's own output when it fails, so
   *  a build error can be quoted back rather than reduced to a status. */
  build: (argv: string[], input: string) => { ok: boolean; output: string };
}

export interface NetworkAttachment {
  network: string;
  ip: string;
}

const nonEmptyLines = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

/** Read (network, ip) PAIRS from one template, deliberately. */
const NETWORKS_TEMPLATE =
  '{{range $n, $c := .NetworkSettings.Networks}}{{$n}}\t{{$c.IPAddress}}{{"\\n"}}{{end}}';

export const parseNetworkAttachments = (text: string): NetworkAttachment[] => {
  const attachments: NetworkAttachment[] = [];
  for (const line of nonEmptyLines(text)) {
    const [network, ip = ""] = line.split("\t");
    if (network) attachments.push({ network, ip });
  }
  return attachments;
};

/** The two labels the devcontainer CLI stamps a project's container with. It
 *  finds that container again by matching BOTH, and so does this file. */
export const IDENTITY_LABELS = {
  workspace: "devcontainer.local_folder",
  config: "devcontainer.config_file",
} as const;

export interface WorkspaceCandidate {
  id: string;
  /** "" when the container carries no config_file label at all. */
  configFile: string;
}

/** Only a constant label NAME is interpolated here -- never a caller's value.
 *  A path with a quote in it would break the template open, which is why the
 *  config file is compared in TypeScript below rather than passed to --filter. */
const WORKSPACE_CANDIDATES_TEMPLATE = `{{.ID}}\t{{.Label "${IDENTITY_LABELS.config}"}}`;

export const parseWorkspaceCandidates = (
  text: string,
): WorkspaceCandidate[] => {
  const candidates: WorkspaceCandidate[] = [];
  for (const line of nonEmptyLines(text)) {
    const [id, configFile = ""] = line.split("\t");
    if (id) candidates.push({ id, configFile: configFile.trim() });
  }
  return candidates;
};

/**
 * Which of the containers claiming a workspace folder is actually this
 * project's.
 *
 * The workspace label ALONE is not an identity. It is written by the CLI before
 * it appends the project's own runArgs, so a project used to be able to stamp a
 * sibling's folder onto its container and be mistaken for it -- policy.ts now
 * refuses `--label`, and this is the second lock. A container naming a
 * DIFFERENT config file is somebody else's; one naming none is ours from before
 * the label existed.
 *
 * `configFile` is optional for when a caller genuinely does not know
 * which config a running container was created from; there the first match is
 * still the best available answer.
 */
export const selectWorkspaceContainer = (
  candidates: WorkspaceCandidate[],
  configFile?: string,
): string => {
  if (!configFile) return candidates[0]?.id ?? "";
  return (
    candidates.find((c) => c.configFile === configFile)?.id ??
    candidates.find((c) => !c.configFile)?.id ??
    ""
  );
};

export interface Mount {
  source: string;
  destination: string;
}

const MOUNTS_TEMPLATE =
  '{{range .Mounts}}{{.Source}}\t{{.Destination}}{{"\\n"}}{{end}}';

export const parseMounts = (text: string): Mount[] => {
  const mounts: Mount[] = [];
  for (const line of nonEmptyLines(text)) {
    const [source, destination = ""] = line.split("\t");
    if (source) mounts.push({ source, destination });
  }
  return mounts;
};

/** What each of the project's own containers gets before it is killed. */
const GRACE_SECONDS = 10;
/** How long the project's daemon gets to exit after its SIGTERM. */
const DAEMON_EXIT_SECONDS = 10;
/** The cap on a whole quiesce program, applied where that program runs. */
const QUIESCE_SECONDS = 30;

/**
 * What a devcontainer with a daemon of its own is asked to do before it is
 * stopped, as two shell programs. Programs rather than argv because both are
 * loops over what they find inside the container.
 */
const QUIESCE = {
  /** Empty is not a failure: `docker stop` with no arguments is an error, and
   *  a project that is simply running nothing must not report as one. */
  containers: `ids=$(docker ps -q); [ -z "$ids" ] || docker stop --time ${GRACE_SECONDS} $ids`,
  /** SIGTERM, then wait for the process to actually be gone -- an exit is the
   *  only evidence that its overlay mounts came down with it. */
  daemon: [
    "pkill -TERM dockerd 2>/dev/null",
    `i=0; while pgrep -x dockerd >/dev/null 2>&1; do` +
      ` [ "$i" -lt ${DAEMON_EXIT_SECONDS} ] || exit 1; sleep 1; i=$((i+1)); done`,
  ].join("; "),
} as const;

/** Every exec into a devcontainer that is on its way down is bounded TWICE:
 *  `timeout` caps the program where it runs, and this caps an exec that never
 *  gets that far. A devcontainer whose daemon is already hung can hang the exec
 *  itself, and `desolate --stop` must not inherit that. */
const EXEC_MS = { quiesce: 45_000, probe: 10_000 } as const;

const capped = (program: string) => [
  "timeout",
  String(QUIESCE_SECONDS),
  "sh",
  "-c",
  program,
];

/** One worktree's sandbox: a throwaway container that reaches exactly what
 *  that worktree's own devcontainer will -- its directory and the project's
 *  `.git`, handed in as `mounts` -- as the editor user, under a label a sweep
 *  can find, and gone when it exits. `seconds` bounds it from INSIDE, so a
 *  hook that hangs ends with its container rather than outliving its caller. */
export interface WorktreeSandbox {
  image: string;
  label: string;
  dir: string;
  mounts: string[];
  seconds: number;
}

const worktreeSandbox = (spec: WorktreeSandbox, entrypoint: string) => [
  "run",
  "--rm",
  "--label",
  spec.label,
  "--user",
  "1000:1000",
  "-e",
  "HOME=/tmp",
  ...spec.mounts.flatMap((mount) => ["--mount", mount]),
  "--workdir",
  spec.dir,
  "--entrypoint",
  entrypoint,
  spec.image,
];

/** Printed by `worktreeChanges` only once `git status` has SUCCEEDED, so a
 *  check that never ran -- no image, a timeout, a git error -- cannot read as
 *  a clean worktree. */
export const STATUS_RAN = "desolate-status-ran";

/** The changed paths `worktreeChanges` reported, [] for a clean worktree, or
 *  null when the check did not run -- which every caller must treat as dirty. */
export const parseWorktreeChanges = (text: string): string[] | null => {
  const lines = text.split("\n");
  const ran = lines.indexOf(STATUS_RAN);
  if (ran < 0) return null;
  return lines.slice(ran + 1).filter((line) => line.trim() !== "");
};

/**
 * Everything a project dind is created with (supervisor.ts builds this from
 * dind.ts names and its environment). Volume names are the daemon's own --
 * compose-prefixed where compose made them.
 */
export interface DindSpec {
  name: string;
  /** `desolate.dind=<project>` (dind.label). */
  label: string;
  /** The network, named for the `br-d-<hash>` bridge it pins. */
  network: string;
  /** `sysbox-runc` in production. `runc` exists for the nested harness and
   *  means --privileged; supervisor.ts refuses it outside that harness. */
  runtime: "sysbox-runc" | "runc";
  image: string;
  /** The project, as a relative path: the subpath of `workspaces` it sees. */
  project: string;
  volumes: {
    data: string;
    workspaces: string;
    sockets: string;
    socketSubpath: string;
    serverDist: string;
    health: string;
  };
  /** Host path of the proxy CA directory (the VM's /var/lib/desolate-proxy/public). */
  caDirectory: string;
  limits: { memory: string; pids: number; cpus: string };
  /** /etc/docker/daemon.json inside the dind: where the BuildKit GC lives. */
  daemonJson: string;
}

/** Inside a project dind, written by its entrypoint before dockerd starts:
 *  the CA (as the shared dind installs it), daemon.json, and the
 *  /var/run/docker.sock ALIAS -- what docker-outside-of-docker's own mount
 *  binds from (sibling-feature.sh F1/F3). */
const DIND_ENTRYPOINT =
  '[ -x /desolate/ca/install-ca.sh ] && /desolate/ca/install-ca.sh >/dev/null 2>&1 || true; ' +
  'mkdir -p /etc/docker && printf "%s" "$DESOLATE_DAEMON_JSON" > /etc/docker/daemon.json; ' +
  'ln -sf /run/dind-sock/docker.sock /var/run/docker.sock; ' +
  'exec dockerd-entrypoint.sh "$@"';

const dindRunArgv = (spec: DindSpec) => [
  "run",
  "-d",
  "--name",
  spec.name,
  "--label",
  spec.label,
  ...(spec.runtime === "runc" ? ["--privileged"] : ["--runtime", spec.runtime]),
  "--network",
  spec.network,
  // NO restart policy, deliberately: a VM reboot must not bring every dind
  // back at once, independently of the projects that wanted them -- the
  // reconciliation storm the relays' policy caused (docker.ts relay.start).
  "--memory",
  spec.limits.memory,
  "--pids-limit",
  String(spec.limits.pids),
  "--cpus",
  spec.limits.cpus,
  "--ulimit",
  "nofile=524288:524288",
  "-e",
  "DOCKER_TLS_CERTDIR=",
  "-e",
  `DESOLATE_DAEMON_JSON=${spec.daemonJson}`,
  "--mount",
  `type=volume,source=${spec.volumes.data},target=/var/lib/docker`,
  "--mount",
  `type=volume,source=${spec.volumes.sockets},target=/run/dind-sock,volume-subpath=${spec.volumes.socketSubpath}`,
  // ONE project, at its own path: the whole of the containment (the socket
  // is root over this daemon, so what it can see is what it can give away).
  "--mount",
  `type=volume,source=${spec.volumes.workspaces},target=/workspaces/${spec.project},volume-subpath=${spec.project}`,
  "--mount",
  `type=volume,source=${spec.volumes.serverDist},target=/server-dist,readonly`,
  "--mount",
  `type=volume,source=${spec.volumes.health},target=/desolate-health,readonly`,
  "--mount",
  `type=bind,source=${spec.caDirectory},target=/desolate,readonly`,
  "--entrypoint",
  "/bin/sh",
  spec.image,
  "-c",
  DIND_ENTRYPOINT,
  "--",
  "dockerd",
  "--host=unix:///run/dind-sock/docker.sock",
  "--group=1000",
  "--default-ulimit=nofile=65536:524288",
];

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;


/**
 * A branch crossing between a project and its remote: `desolate --push` and
 * `--pull` (transfer.ts). The editor never runs git in a project -- it would
 * obey the project's hooks and config with every deploy key in reach -- so
 * the project's half runs here, in a sandbox that sees that project alone,
 * and the two halves meet at a bundle file in the project's own git dir.
 */
export const BUNDLED = "desolate-bundled";
export const PULLED = "desolate-pulled";
const TRANSFER_GIT = 'g() { git -c core.hooksPath=/dev/null -c core.fsmonitor=false "$@"; }';

/** $1 the target's directory, $2 where to write the bundle, $3 the commits
 *  the editor's cache already has (one per line; its `.haves` file). Bundles
 *  the branch checked out there, less what the cache has -- or, when the cache
 *  has all of it, nothing, and says so. */
export const bundleScript = [
  TRANSFER_GIT,
  'dir=$1 out=$2 haves=$3',
  'trap \'rm -f "$haves"\' EXIT',
  'branch=$(g -C "$dir" symbolic-ref -q --short HEAD) || { echo "no branch is checked out in $dir" >&2; exit 3; }',
  'commit=$(g -C "$dir" rev-parse "refs/heads/$branch") || exit 4',
  // Only the ones this project has: a commit it lacks cannot be left out.
  'excludes=""',
  'if [ -f "$haves" ]; then while read -r have; do case "$have" in ""|*[!0-9a-f]*) continue ;; esac; ' +
    'g -C "$dir" cat-file -e "$have^{commit}" 2>/dev/null && excludes="$excludes ^$have"; done < "$haves"; fi',
  `if [ -n "$excludes" ] && [ -z "$(g -C "$dir" rev-list -n 1 "refs/heads/$branch" $excludes)" ]; then echo ${BUNDLED} "$branch" "$commit" none; exit 0; fi`,
  'g -C "$dir" bundle create --quiet "$out" "refs/heads/$branch" $excludes || exit 5',
  `echo ${BUNDLED} "$branch" "$commit" bundled`,
].join("; ");

/** $1 the target's directory, $2 the bundle the editor wrote (absent when the
 *  project needs no objects), $3 the remote's branches (`<commit> <name>` per
 *  line; its `.refs` file), $4 the CA. origin/* becomes exactly that list --
 *  every commit of which this project must then have, or it says `needs-full`
 *  and changes nothing. The branch checked out is fast-forwarded to its own
 *  when it can be, and otherwise left as it is. The merge is the project's own
 *  git, hooks and filters and all -- in here, where they reach nothing but this
 *  project. $5 `fetch` stops once origin/* is set: nothing checked out moves. */
export const pullScript = [
  TRANSFER_GIT,
  'dir=$1 bundle=$2 refs=$3 ca=$4',
  'trap \'rm -f "$bundle" "$refs"\' EXIT',
  `say() { echo ${PULLED} "$@"; exit 0; }`,
  '[ -f "$refs" ] || exit 6',
  'if [ -s "$bundle" ]; then g -C "$dir" bundle verify --quiet "$bundle" >/dev/null 2>&1 || say needs-full -; ' +
    'g -C "$dir" fetch --quiet --no-tags "$bundle" "+refs/heads/*:refs/desolate/incoming/*" || exit 4; fi',
  'while read -r commit name; do g -C "$dir" cat-file -e "$commit^{commit}" 2>/dev/null || say needs-full -; done < "$refs"',
  'while read -r commit name; do g check-ref-format "refs/remotes/origin/$name" && g -C "$dir" update-ref "refs/remotes/origin/$name" "$commit"; done < "$refs"',
  'g -C "$dir" for-each-ref --format="%(refname)" refs/remotes/origin/ refs/desolate/incoming/ | while read -r old; do ' +
    'case "$old" in refs/remotes/origin/HEAD) continue ;; refs/remotes/origin/*) cut -d" " -f2- "$refs" | grep -qxF "${old#refs/remotes/origin/}" && continue ;; esac; ' +
    'g -C "$dir" update-ref -d "$old"; done',
  '[ "${5:-}" != fetch ] || say fetched -',
  'branch=$(g -C "$dir" symbolic-ref -q --short HEAD) || say fetched -',
  'g -C "$dir" rev-parse -q --verify "refs/remotes/origin/$branch" >/dev/null || say fetched "$branch"',
  'g -C "$dir" merge-base --is-ancestor "refs/remotes/origin/$branch" HEAD && say current "$branch"',
  'g -C "$dir" merge-base --is-ancestor HEAD "refs/remotes/origin/$branch" || say diverged "$branch"',
  'git -C "$dir" -c "http.sslCAInfo=$ca" merge --ff-only --quiet "refs/remotes/origin/$branch" && say fast-forwarded "$branch"',
  'say blocked "$branch"',
].join("; ");

/**
 * How `cli.sh exec` runs a command in a devcontainer (desolate.ts execTarget):
 * in a login shell, so the PATH its features set up is there. bash's when the
 * container has bash, as its own terminals are -- features write their login
 * scripts for bash, and git-subrepo's loads a bash-only .rc that a login `sh`
 * (dash) chokes on, leaving git-subrepo off PATH -- and sh's otherwise. The
 * command is "$@", never spliced into the script.
 */
export const LOGIN_EXEC = String.raw`if command -v bash >/dev/null 2>&1; then exec bash -lc 'exec "$@"' bash "$@"; fi; exec sh -lc 'exec "$@"' sh "$@"`;

/**
 * What `desolate --push` would send, for a person to read first (`desolate
 * --review`): the branch checked out in $1, what it is compared with, the
 * commits and files that differ, and each file's two sides -- read-only, in
 * the target's sandbox like the push's own half. Nothing is written.
 *
 * Compared with GitHub's copy of the branch as the last pull or fetch left it
 * (origin/<branch>); for a branch GitHub does not have, with the origin branch
 * it has the fewest commits beyond -- where it started. The diff is from where
 * the two meet, so it is what the branch adds. Lines, tab-separated:
 *
 *   BRANCH <name or -> <head>        BASE <ref or -> <its commit or -> <merge-base or ->
 *   COUNTS <ahead> <behind> <uncommitted entries>
 *   COMMIT <sha> <author time> <author> <subject>     (newest first, at most $5)
 *   FILE <n> <status> <mode a> <mode b> <blob a> <blob b> <size a> <size b> <kind> <path>[ <path>]
 *   BLOB <n> <a|b> <a line of base64>                  (a `text` file's sides)
 *   MORE (past $4 files)   END
 *
 * Paths are git's, quoted when they hold a tab, a newline, a quote or a
 * backslash. Content is read by blob id (`cat-file blob`), so no filter or
 * textconv of the project's runs; `kind` is text, binary, large or module.
 */
export const reviewScript = String.raw`set -u
g() { git -c core.hooksPath=/dev/null -c core.fsmonitor=false -c core.quotePath=false "$@"; }
dir=$1 blobmax=$2 totalmax=$3 filesmax=$4 commitsmax=$5
T=$(printf '\t')
say() { line=${REVIEWED}; for field in "$@"; do line="$line$T$field"; done; printf '%s\n' "$line"; }
cd "$dir" || exit 2
head=$(g rev-parse -q --verify 'HEAD^{commit}') || { echo "nothing is committed in $dir" >&2; exit 3; }
branch=$(g symbolic-ref -q --short HEAD) || branch=
say BRANCH "${'$'}{branch:--}" "$head"
base=
if [ -n "$branch" ] && g rev-parse -q --verify "refs/remotes/origin/$branch^{commit}" >/dev/null; then
  base=origin/$branch
else
  best=
  for ref in $(g for-each-ref --sort=-committerdate --count=100 --format='%(refname:short)' refs/remotes/origin/); do
    case "$ref" in origin|origin/HEAD) continue ;; esac
    n=$(g rev-list --count "$ref..HEAD" 2>/dev/null) || continue
    if [ -z "$best" ] || [ "$n" -lt "$best" ]; then best=$n base=$ref; fi
  done
fi
from=
if [ -n "$base" ]; then
  basecommit=$(g rev-parse -q --verify "$base^{commit}")
  from=$(g merge-base "$basecommit" HEAD) || from=
  ahead=$(g rev-list --count "$basecommit..HEAD") behind=$(g rev-list --count "HEAD..$basecommit")
  range=$basecommit..HEAD
else
  basecommit= ahead=$(g rev-list --count HEAD) behind=0 range=HEAD
fi
say BASE "${'$'}{base:--}" "${'$'}{basecommit:--}" "${'$'}{from:--}"
say COUNTS "$ahead" "$behind" "$(g status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
g log --max-count="$commitsmax" --format="%H%x09%at%x09%aN%x09%s" "$range" | sed "s/^/${REVIEWED}${'$'}{T}COMMIT${'$'}{T}/"
left=${'$'}{from:-$(g hash-object -t tree /dev/null)}
zero=0000000000000000000000000000000000000000
g -c diff.renameLimit=1000 diff --raw --no-abbrev -M "$left" HEAD | {
  i=0 total=0
  while IFS= read -r line; do
    i=$((i + 1))
    if [ "$i" -gt "$filesmax" ]; then say MORE; break; fi
    meta=${'$'}{line%%"$T"*} paths=${'$'}{line#*"$T"}
    set -- $meta
    ma=${'$'}{1#:} mb=$2 a=$3 b=$4 st=$5
    sa=0 sb=0 kind=text
    case "$ma$mb" in 160000*|*160000) kind=module ;; esac
    if [ "$kind" = text ]; then
      [ "$a" = "$zero" ] || sa=$(g cat-file -s "$a")
      [ "$b" = "$zero" ] || sb=$(g cat-file -s "$b")
      if [ "$sa" -gt "$blobmax" ] || [ "$sb" -gt "$blobmax" ] || [ $((total + sa + sb)) -gt "$totalmax" ]; then
        kind=large
      else
        for blob in "$a" "$b"; do
          [ "$blob" = "$zero" ] && continue
          head8k=$(g cat-file blob "$blob" | head -c 8000 | wc -c)
          kept=$(g cat-file blob "$blob" | head -c 8000 | tr -d '\000' | wc -c)
          [ "$head8k" -eq "$kept" ] || kind=binary
        done
      fi
    fi
    say FILE "$i" "$st" "$ma" "$mb" "$a" "$b" "$sa" "$sb" "$kind" "$paths"
    [ "$kind" = text ] || continue
    total=$((total + sa + sb))
    [ "$a" = "$zero" ] || g cat-file blob "$a" | base64 | sed "s/^/${REVIEWED}${'$'}{T}BLOB${'$'}{T}$i${'$'}{T}a${'$'}{T}/"
    [ "$b" = "$zero" ] || g cat-file blob "$b" | base64 | sed "s/^/${REVIEWED}${'$'}{T}BLOB${'$'}{T}$i${'$'}{T}b${'$'}{T}/"
  done
}
say END
`;

/**
 * A project's suede dependencies, as git sees them at one commit (`deps
 * report`), and the commit that proposes one of them upstream (`deps build`)
 * -- run in the project's sandbox, which sees that project alone, with no
 * network: the dependency's history comes from a bundle desolate delivered
 * into the project's git dir (`.git/desolate-dep-<owner>__<repo>.bundle`).
 *
 * A suede dependency is a subrepo tracking `release`, other than the
 * project's own `release/` (docs/suede-factory.md). Its proposal is its
 * folder at that commit, less what is not the consumer's to propose: its
 * `.gitrepo`, and every subrepo nested inside it -- a nested one is proposed
 * to its own repository, and the outer one keeps its pinned copy. One commit,
 * parented on the pin: what suede's suede-downstream-to-main rebuilds from
 * (merge-base with release), as it would from `git subrepo push`.
 *
 *   sh -c depsScript deps report <ref>
 *   sh -c depsScript deps build  <ref> <dir> <out-bundle> <who>
 *
 * Every line it prints is a record: DEPS_* below, tab-separated.
 */
export const depsScript = String.raw`set -u
g() { git -c core.hooksPath=/dev/null -c core.fsmonitor=false "$@"; }
export GIT_LITERAL_PATHSPECS=1
mode=$1 ref=$2
shift 2
commit=$(g rev-parse --verify -q "$ref^{commit}") || { echo "no commit at $ref" >&2; exit 3; }
work=$(mktemp -d) || exit 4
trap 'rm -rf "$work"' EXIT
gitdir=$(cd "$(g rev-parse --git-common-dir)" && pwd -P) || exit 4
TAB=$(printf '\t')

# A remote URL -> owner__repo, or nothing.
tag_of() {
  printf '%s\n' "$1" | sed -E 's#/+$##; s#\.git$##; s#^[A-Za-z][A-Za-z0-9+.-]*://[^/]*/##; s#^[^@/]+@[^:/]+:##' \
    | awk -F/ 'NF >= 2 && $(NF-1) ~ /^[A-Za-z0-9._-]+$/ && $NF ~ /^[A-Za-z0-9._-]+$/ { print $(NF-1) "__" $NF }'
}

# The pinned commit, from the delivered bundle if it is not here yet.
have_pin() {
  g cat-file -e "$1^{commit}" 2>/dev/null && return 0
  bundle="$gitdir/desolate-dep-$2.bundle"
  [ -n "$2" ] && [ -f "$bundle" ] && [ ! -L "$bundle" ] || return 1
  g fetch --quiet --no-tags "$bundle" "+refs/heads/*:refs/desolate/deps/$2/*" >/dev/null 2>&1
  g cat-file -e "$1^{commit}" 2>/dev/null
}

# Its folder at the commit, with .gitrepo and every nested subrepo as the pin has them.
proposal_tree() {
  index="$work/index"
  rm -f "$index"
  GIT_INDEX_FILE=$index g read-tree "$commit:$1" || return 1
  { echo .gitrepo; cat "$work/nested"; } | while IFS= read -r path; do
    [ -n "$path" ] || continue
    GIT_INDEX_FILE=$index g ls-files -z -- "$path" | GIT_INDEX_FILE=$index g update-index -z --force-remove --stdin
    g ls-tree -r -z "$2" -- "$path" | GIT_INDEX_FILE=$index g update-index -z --index-info
  done
  GIT_INDEX_FILE=$index g write-tree
}

g ls-tree -r --name-only "$commit" | grep -E '(^|/)\.gitrepo$' | sed -E 's#/?\.gitrepo$##' | grep -v '^$' > "$work/subrepos"

# One dependency: its .gitrepo, its pin, its proposal tree. Returns 1 when it is no suede dependency.
load() {
  dir=$1
  [ "$dir" != release ] || return 1
  [ "$(g config --blob "$commit:$dir/.gitrepo" subrepo.branch 2>/dev/null)" = release ] || return 1
  remote=$(g config --blob "$commit:$dir/.gitrepo" subrepo.remote 2>/dev/null)
  pin=$(g config --blob "$commit:$dir/.gitrepo" subrepo.commit 2>/dev/null)
  tag=$(tag_of "$remote")
  awk -v d="$dir" 'index($0, d "/") == 1 { print substr($0, length(d) + 2) }' "$work/subrepos" > "$work/nested"
}

case "$mode" in
  report)
    printf 'REF\t%s\n' "$commit"
    [ "$(g config --blob "$commit:release/.gitrepo" subrepo.branch 2>/dev/null)" = release ] && printf 'SUEDE\n'
    g ls-tree "$commit" | awk -F'\t' '$1 ~ /^120000 blob / { split($1, a, " "); print a[3] "\t" $2 }' \
      | while IFS="$TAB" read -r blob name; do printf 'LINK\t%s\t%s\n' "$name" "$(g cat-file blob "$blob")"; done
    while IFS= read -r d; do
      load "$d" || continue
      printf 'DEP\t%s\t%s\t%s\t%s\n' "$d" "$tag" "$pin" "$remote"
      have_pin "$pin" "$tag" || { printf 'NOPIN\t%s\n' "$d"; continue; }
      tree=$(proposal_tree "$d" "$pin") || { printf 'FAILED\t%s\n' "$d"; continue; }
      if [ "$tree" = "$(g rev-parse "$pin^{tree}")" ]; then printf 'SAME\t%s\n' "$d"; continue; fi
      printf 'DIFF\t%s\t%s\n' "$d" "$(g diff-tree -r -p "$pin" "$tree" | g patch-id --stable | cut -d' ' -f1)"
      g diff-tree -r --name-status "$pin" "$tree" | while IFS= read -r line; do printf 'FILE\t%s\t%s\n' "$d" "$line"; done
    done < "$work/subrepos"
    ;;
  build)
    d=$1 out=$2 who=$3
    load "$d" || { echo "$d is not a suede dependency at $commit" >&2; exit 5; }
    have_pin "$pin" "$tag" || { echo "$d's pinned commit $pin is not here: deliver its repository first" >&2; exit 6; }
    tree=$(proposal_tree "$d" "$pin") || exit 7
    if [ "$tree" = "$(g rev-parse "$pin^{tree}")" ]; then printf 'BUILT\tnone\n'; exit 0; fi
    patch=$(g diff-tree -r -p "$pin" "$tree" | g patch-id --stable | cut -d' ' -f1)
    parent=$(g config --blob "$commit:$d/.gitrepo" subrepo.parent 2>/dev/null)
    {
      printf 'Changes to %s proposed by %s\n\nFrom %s at %s. Its commits that touched %s:\n\n' "$d" "$who" "$who" "$commit" "$d"
      if [ -n "$parent" ] && g merge-base --is-ancestor "$parent" "$commit" 2>/dev/null; then
        g log --format='- %h %s' "$parent..$commit" -- "$d"
      else
        g log --format='- %h %s' -20 "$commit" -- "$d"
      fi
    } > "$work/message"
    new=$(GIT_AUTHOR_NAME="$who" GIT_AUTHOR_EMAIL=desolate@localhost GIT_COMMITTER_NAME=desolate GIT_COMMITTER_EMAIL=desolate@localhost \
      g commit-tree "$tree" -p "$pin" -F "$work/message") || exit 8
    g update-ref refs/desolate/upstream/outgoing "$new" || exit 8
    g bundle create --quiet "$out" refs/desolate/upstream/outgoing "^$pin" || { g update-ref -d refs/desolate/upstream/outgoing; exit 9; }
    g update-ref -d refs/desolate/upstream/outgoing
    printf 'BUILT\t%s\t%s\t%s\t%s\t%s\n' "$new" "$pin" "$tag" "$commit" "$patch"
    ;;
  *) echo "deps: report or build" >&2; exit 2 ;;
esac
`;

/** A suede dependency, as `cli.sh suede report` found it. */
export interface DependencyReport {
  /** Its folder, relative to the project root. */
  dir: string;
  /** Its repository, `owner/repo`, when its remote names one. */
  repo?: string;
  remote: string;
  pin: string;
  /** How the project consumes it -- what is at stake if it diverges:
   *  `release`: declared by a root symlink: the project, itself a suede
   *    dependency, ships a pointer to it, and its publish is refused while
   *    the copy diverges;
   *  `vendored`: inside `release/`: shipped as source;
   *  `development`: anything else, in a project that is a suede dependency;
   *  `app`: in a project that is not one. */
  kind: "release" | "vendored" | "development" | "app";
  /** `same` as its pin, `diff`ers, its pin is not here (`nopin`: deliver
   *  its repository), or the comparison `failed`. */
  state: "same" | "diff" | "nopin" | "failed";
  /** `git patch-id --stable` of the difference: equal for the same change. */
  patch?: string;
  files: { status: string; path: string }[];
}

export interface DepsReport {
  commit: string;
  /** The project is itself a suede dependency (its `release/.gitrepo` tracks release). */
  suede: boolean;
  dependencies: DependencyReport[];
}

/** `cli.sh suede report`'s records, as one document. */
export const parseDepsReport = (text: string): DepsReport | null => {
  const rows = text.split("\n").filter(Boolean).map((line) => line.split("\t"));
  const commit = rows.find(([kind]) => kind === "REF")?.[1];
  if (!commit || !/^[0-9a-f]{40,64}$/.test(commit)) return null;
  const suede = rows.some(([kind]) => kind === "SUEDE");
  const links = new Map(rows.filter(([kind]) => kind === "LINK")
    .map(([, name, target]) => [name, (target ?? "").replace(/^\.\//, "").replace(/\/+$/, "")]));
  const declared = new Set(links.values());
  const dependencies: DependencyReport[] = [];
  for (const [kind, dir, ...rest] of rows) {
    if (kind === "DEP") {
      const [tag, pin, remote] = rest;
      dependencies.push({
        dir, remote: remote ?? "", pin: pin ?? "",
        ...(tag && /^[A-Za-z0-9._-]+__[A-Za-z0-9._-]+$/.test(tag) ? { repo: tag.replace("__", "/") } : {}),
        kind: !suede ? "app" : dir.startsWith("release/") ? "vendored" : declared.has(dir) ? "release" : "development",
        state: "failed", files: [],
      });
      continue;
    }
    const dependency = dependencies.find((d) => d.dir === dir);
    if (!dependency) continue;
    if (kind === "SAME") dependency.state = "same";
    else if (kind === "NOPIN") dependency.state = "nopin";
    else if (kind === "DIFF") { dependency.state = "diff"; dependency.patch = rest[0]; }
    else if (kind === "FILE") {
      const [status, ...path] = rest;
      dependency.files.push({ status: status ?? "", path: path.join("\t") });
    }
  }
  return { commit, suede, dependencies };
};

/** What `reclaim` reports once it has run: the count of entries it changed.
 *  Absent, the reclaim did not finish -- which every caller must say. */
export const RECLAIMED = "desolate-reclaimed";

/** Hand back to `uid` everything under `inProject` (relative to the project's
 *  root), as root in a helper with no network and only the capabilities a
 *  chown needs. The PROJECT root is the mount, never the path asked about: a
 *  symlink in the tree then resolves inside this container, never onto
 *  another project's files, and -h changes links rather than what they name. */
export const reclaimArgv = (image: string, projectDir: string, inProject: string, uid: number) => [
  "run", "--rm", "--network", "none", "--user", "0:0",
  "--cap-drop", "ALL", "--cap-add", "CHOWN", "--cap-add", "DAC_OVERRIDE", "--cap-add", "DAC_READ_SEARCH",
  "--security-opt", "no-new-privileges",
  "--mount", `type=bind,source=${projectDir},target=/w`,
  "--entrypoint", "sh", image, "-c",
  `n=$(find "$1" \\( ! -user ${uid} -o ! -group ${uid} \\) | wc -l) && ` +
    `chown -R -h ${uid}:${uid} -- "$1" && echo ${RECLAIMED} "$n"`,
  "reclaim", `/w/${inProject}`,
];

/** socat's SYSTEM address, double-quoted for socat's own parser (which would
 *  otherwise split the command on its colons). Only addresses and a port reach
 *  it, each checked first: this string is run by a shell. */
export const relayWithFallback = (first: string, then: string, port: number) => {
  if (!IPV4.test(first) || !IPV4.test(then) || !Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error(`refusing to build a relay command from '${first}', '${then}', '${port}'`);
  return `system:"socat - TCP:${first}:${port},connect-timeout=2 || exec socat - TCP:${then}:${port}"`;
};

export const createDocker = (run: Runner) => {
  const query = (...argv: string[]) => run.output(argv);
  const effect = (...argv: string[]) => run.status(argv);

  const container = {
    /** The devcontainer's container id for a workspace folder ("" if none).
     *
     *  `configFile` is the second half of the CLI's identity, and the half a
     *  project could not forge even when it could still set labels -- so pass
     *  it wherever it is known. It is the config the CLI STAMPS, which is the
     *  one inside the workspace folder whatever `--override-config` said; see
     *  `labelledConfig`. Passing an override path matches nothing. */
    forWorkspace: (
      dir: string,
      { includeStopped = false, configFile = "" } = {},
    ) =>
      selectWorkspaceContainer(
        parseWorkspaceCandidates(
          // No `-q`: it is shorthand for `--format {{.ID}}` and would drop the
          // config-file column this lookup is built on.
          query(
            "ps",
            ...(includeStopped ? ["-a"] : []),
            "--filter",
            `label=${IDENTITY_LABELS.workspace}=${dir}`,
            "--format",
            WORKSPACE_CANDIDATES_TEMPLATE,
          ),
        ),
        configFile,
      ),
    /** The workspace folder of every RUNNING devcontainer, in ONE call.
     *
     *  For finding which of many targets are up, where asking per target would
     *  be a `docker ps` per directory on disk. It is a listing and not an
     *  identity -- `forWorkspace` pairs this label with the config-file one
     *  because either alone could once be claimed by a sibling -- so anything
     *  that ACTS on what this finds looks it up there first. */
    runningWorkspaceFolders: () =>
      new Set(
        nonEmptyLines(
          query(
            "ps",
            "--filter",
            `label=${IDENTITY_LABELS.workspace}`,
            "--format",
            `{{.Label "${IDENTITY_LABELS.workspace}"}}`,
          ),
        ),
      ),
    /** The `devcontainer.metadata` label the CLI stamped a container with:
     *  what it was BUILT from, which `up` will start it as. "" when absent. */
    metadata: (id: string) =>
      query("inspect", "-f", '{{index .Config.Labels "devcontainer.metadata"}}', id).trim().replace(/^<no value>$/, ""),
    namesWithLabel: (label: string) =>
      nonEmptyLines(
        query(
          "ps",
          "-a",
          "--filter",
          `label=${label}`,
          "--format",
          "{{.Names}}",
        ),
      ),
    /** `{{.Names}}\t{{.Ports}}` for every RUNNING container. */
    publishedPortsTable: () =>
      query("ps", "--format", "{{.Names}}\t{{.Ports}}"),
    networks: (cid: string) =>
      parseNetworkAttachments(query("inspect", "-f", NETWORKS_TEMPLATE, cid)),
    state: (name: string) => query("inspect", "-f", "{{.State.Status}}", name),
    logsTail: (name: string, lines: number) =>
      query("logs", "--tail", String(lines), name),
    /** Every (source, destination) bind the container was created with.
     *
     *  No value is interpolated into the template. The broker validates project
     *  names, but `cli.sh desolate` is a direct path where a quote in a path
     *  would break the template open -- so the whole table is read and matched
     *  in TypeScript instead. */
    /** Was it started --privileged (a pre-v2 docker-in-docker devcontainer)? */
    isPrivileged: (cid: string) => query("inspect", "-f", "{{.HostConfig.Privileged}}", cid) === "true",
    /** The NAMES of the volumes it mounts. */
    volumeNames: (cid: string) =>
      nonEmptyLines(query("inspect", "-f", '{{range .Mounts}}{{if .Name}}{{.Name}}{{"\\n"}}{{end}}{{end}}', cid)),
    mounts: (cid: string) =>
      parseMounts(query("inspect", "-f", MOUNTS_TEMPLATE, cid)),
    remove: (names: string[]) =>
      names.length ? effect("rm", "-f", ...names) : 0,
    stop: (cid: string) => effect("stop", cid),
    /** Run something as root in the container and WAIT for it.
     *
     *  There is deliberately no detached (`exec -d`) sibling: work slow enough
     *  to want backgrounding is work that can still hold mounts when the
     *  container is stopped, and a container stopped that way cannot be stopped
     *  at all. */
    execAsRoot: (
      cid: string,
      argv: string[],
      { quiet = true, timeoutMs }: RunOptions = {},
    ) => run.status(["exec", "-u", "0", cid, ...argv], { quiet, timeoutMs }),

    /** Whether the container has a docker CLI, and so a daemon of its own --
     *  which is what the docker-in-docker feature installs.
     *
     *  Bounded, because one of the two questions this answers is asked of a
     *  container that is being stopped, and a container that cannot answer at
     *  all is one there is no daemon to talk to either way. */
    hasDockerCli: (cid: string) =>
      container.execAsRoot(
        cid,
        ["sh", "-c", "command -v docker >/dev/null 2>&1"],
        { timeoutMs: EXEC_MS.probe },
      ) === 0,

    /** Ask the container's own daemon to put its containers away, so their
     *  mount namespaces are gone before the container holding them is stopped. */
    stopInnerContainers: (cid: string) =>
      container.execAsRoot(cid, capped(QUIESCE.containers), {
        timeoutMs: EXEC_MS.quiesce,
      }),

    /** ...and then to stop itself, so the mounts IT holds come down too. */
    stopInnerDaemon: (cid: string) =>
      container.execAsRoot(cid, capped(QUIESCE.daemon), {
        timeoutMs: EXEC_MS.quiesce,
      }),
  };

  const volume = {
    label: (name: string, label: string) =>
      query("volume", "inspect", name, "-f", `{{index .Labels "${label}"}}`),
    mountpoint: (name: string) =>
      query("volume", "inspect", name, "-f", "{{.Mountpoint}}"),
    /** The `o=` the daemon actually stored, for comparing against the one a
     *  fresh create would use. */
    options: (name: string) =>
      query("volume", "inspect", name, "-f", '{{index .Options "o"}}'),
    create: (name: string, labels: Record<string, string> = {}) =>
      effect(
        "volume",
        "create",
        ...Object.entries(labels).flatMap(([k, v]) => ["--label", `${k}=${v}`]),
        name,
      ),
    createOverlay: (
      name: string,
      options: string,
      labels: Record<string, string>,
    ) =>
      effect(
        "volume",
        "create",
        "--driver",
        "local",
        "--opt",
        "type=overlay",
        "--opt",
        "device=overlay",
        "--opt",
        `o=${options}`,
        ...Object.entries(labels).flatMap(([k, v]) => ["--label", `${k}=${v}`]),
        name,
      ),
    remove: (names: string[]) =>
      names.length ? effect("volume", "rm", "-f", ...names) : 0,
  };

  const image = {
    /** "" when the image is not present locally. */
    id: (tag: string) => query("image", "inspect", "-f", "{{.Id}}", tag),
    pull: (tag: string) => run.status(["pull", tag], { quiet: true }),
    /** The registry digests a local image is known by, `repo@sha256:...`
     *  each; none for an image that was only ever built here. */
    repoDigests: (tag: string): string[] => {
      try {
        const digests = JSON.parse(query("image", "inspect", "-f", "{{json .RepoDigests}}", tag) || "[]");
        return Array.isArray(digests) ? digests.filter((d): d is string => typeof d === "string") : [];
      } catch {
        return [];
      }
    },
    /** The image's declared USER, or "root" when it declares none.
     *
     *  A derived image has to restore it: building as root and leaving it there
     *  breaks the devcontainer CLI's assumptions about the image user. */
    user: (tag: string) =>
      query("image", "inspect", "-f", "{{.Config.User}}", tag) || "root",
    /** Build from a Dockerfile fed on stdin, so nothing is written to disk. */
    build: (tag: string, dockerfile: string, context: string) =>
      run.build(["build", "-t", tag, "-f", "-", context], dockerfile),
  };

  return {
    container,
    volume,
    image,
    /** Check a worktree out in its sandbox (`worktreeSandbox`). The
     *  repository's hooks, filters and fsmonitor run HERE, which is why it is
     *  not the editor (worktrees.ts). Output is the user's: a post-checkout
     *  hook may have something to say. */
    checkoutWorktree: (spec: WorktreeSandbox & { caFile: string }) =>
      run.status([
        ...worktreeSandbox(spec, "timeout"),
        String(spec.seconds),
        "git",
        "-c",
        `http.sslCAInfo=${spec.caFile}`,
        "checkout",
        "--force",
      ]),
    /** A step of a worktree's life -- `createScript`, `removeScript`
     *  (worktrees.ts) -- run in its sandbox, `args` as the script's positional
     *  parameters and never spliced into it. Its output is the user's. */
    worktreeScript: (spec: WorktreeSandbox, script: string, args: string[]) =>
      run.status([
        ...worktreeSandbox(spec, "timeout"),
        String(spec.seconds),
        "sh",
        "-c",
        script,
        "desolate-worktree",
        ...args,
      ]),
    /** `bundleScript` in a target's sandbox: the branch, its commit and the
     *  bundle's path, or null when it did not finish. */
    bundleBranch: (spec: WorktreeSandbox, targetDir: string, out: string, haves: string) => {
      const said = query(...worktreeSandbox(spec, "sh"), "-c", bundleScript, "bundle", targetDir, out, haves);
      const match = new RegExp(`^${BUNDLED} (\\S+) ([0-9a-f]{40,64}) (bundled|none)$`, "m").exec(said);
      return match ? { branch: match[1], commit: match[2], bundled: match[3] === "bundled" } : null;
    },
    /** `pullScript` in a target's sandbox: what became of its branch, or null
     *  when it did not finish. */
    pullBranch: (spec: WorktreeSandbox & { caFile: string }, targetDir: string, bundle: string, refs: string, fetchOnly = false) => {
      const said = query(...worktreeSandbox(spec, "timeout"), String(spec.seconds), "sh", "-c", pullScript, "pull", targetDir, bundle, refs, spec.caFile, fetchOnly ? "fetch" : "merge");
      const match = new RegExp(`^${PULLED} (fetched|current|diverged|fast-forwarded|blocked|needs-full) (\\S+)$`, "m").exec(said);
      return match ? { outcome: match[1], branch: match[2] } : null;
    },
    /** `reviewScript` in a target's sandbox, its lines straight to this
     *  process's stdout -- a review can be megabytes, and the broker relays
     *  them to the editor as they come (review.ts reads them there). */
    reviewBranch: (spec: WorktreeSandbox, targetDir: string) =>
      run.status([
        ...worktreeSandbox(spec, "timeout"),
        String(spec.seconds),
        "sh",
        "-c",
        reviewScript,
        "review",
        targetDir,
        String(REVIEW_LIMITS.blobBytes),
        String(REVIEW_LIMITS.totalBytes),
        String(REVIEW_LIMITS.files),
        String(REVIEW_LIMITS.commits),
      ]),
    /** `depsScript report` in a project's sandbox, parsed; null when it did not finish. */
    depsReport: (spec: WorktreeSandbox, ref: string) =>
      parseDepsReport(query(...worktreeSandbox(spec, "timeout"), String(spec.seconds), "sh", "-c", depsScript, "deps", "report", ref)),
    /** `depsScript build`: the proposal commit, bundled at `out` (a path in the
     *  project's git dir); `none` when the folder is its pin; null on failure. */
    depsBuild: (spec: WorktreeSandbox, ref: string, dir: string, out: string, who: string) => {
      const said = query(...worktreeSandbox(spec, "timeout"), String(spec.seconds), "sh", "-c", depsScript, "deps", "build", ref, dir, out, who);
      if (/^BUILT	none$/m.test(said)) return "none" as const;
      const built = /^BUILT	([0-9a-f]{40,64})	([0-9a-f]{40,64})	(\S*)	([0-9a-f]{40,64})	([0-9a-f]*)$/m.exec(said);
      return built ? { commit: built[1], pin: built[2], tag: built[3], consumerCommit: built[4], patch: built[5] } : null;
    },
    /** `reclaimArgv`, run: the number of entries it changed, or null when
     *  it did not finish. */
    reclaim: (image: string, projectDir: string, inProject: string, uid: number) => {
      const out = query(...reclaimArgv(image, projectDir, inProject, uid));
      const match = new RegExp(`^${RECLAIMED} (\\d+)$`, "m").exec(out);
      return match ? Number(match[1]) : null;
    },
    /** `git status --porcelain` of a worktree, asked in its sandbox: the one
     *  question about content the editor must not ask itself. Read it with
     *  `parseWorktreeChanges`; untracked files count and ignored ones do not,
     *  as for `git worktree remove`'s own check.
     *
     *  ANY warning fails the check. git exits 0 with only a warning for a
     *  directory it cannot read -- root-owned output of a compose service,
     *  say -- and those files would otherwise be reported as nothing. The
     *  warnings are printed before the marker, so a refusal can quote them. */
    worktreeChanges: (spec: WorktreeSandbox) =>
      run.output([
        ...worktreeSandbox(spec, "sh"),
        "-c",
        `timeout ${spec.seconds} git status --porcelain --ignore-submodules=none ` +
          `> /tmp/changes 2> /tmp/warnings; ran=$?; cat /tmp/warnings; ` +
          `[ "$ran" = 0 ] && [ ! -s /tmp/warnings ] && echo ${STATUS_RAN} && cat /tmp/changes`,
      ]),
    /** How many CPUs the daemon's machine has; 0 when it will not say. */
    cpus: () => Number(query("info", "--format", "{{.NCPU}}")) || 0,
    /** Networks someone made on this daemon (compose's, a project's own), as
     *  opposed to docker's bridge/host/none. */
    /** The gateway of a network: from a container on it, the daemon's own host. */
    networkGateway: (network: string) =>
      query("network", "inspect", "-f", "{{range .IPAM.Config}}{{.Gateway}}{{end}}", network),
    userNetworks: () => nonEmptyLines(query("network", "ls", "--filter", "type=custom", "--format", "{{.Name}}")),
    connectNetwork: (network: string, cid: string) => effect("network", "connect", network, cid),
    /** The daemon's own version, for a refusal that may be about it. */
    version: () => query("version", "--format", "{{.Server.Version}}") || "unknown",
    /** A project's own daemon (supervisor.ts is the only caller). */
    dind: {
      networkExists: (network: string) =>
        query("network", "inspect", "-f", "{{.Name}}", network) === network,
      createNetwork: (network: string, bridge: string, label: string) =>
        effect(
          "network",
          "create",
          "--driver",
          "bridge",
          "--opt",
          `com.docker.network.bridge.name=${bridge}`,
          "--label",
          label,
          network,
        ),
      removeNetwork: (network: string) => effect("network", "rm", network),
      /** Created AND started: `run -d`. */
      create: (spec: DindSpec) => effect(...dindRunArgv(spec)),
      start: (name: string) => effect("start", name),
      /** The container, and so its daemon, alone: rung 2 of `cli.sh dind reset`. */
      restart: (name: string) => effect("restart", "-t", "10", name),
      /** The project a dind serves, from its label: "" for any other container. */
      projectOf: (name: string, labelKey: string) =>
        query("inspect", "-f", `{{index .Config.Labels "${labelKey}"}}`, name),
      /** "" when there is no such container. */
      state: (name: string) => query("inspect", "-f", "{{.State.Status}}", name),
      /** Its memory ceiling in bytes; 0 for none, NaN when it cannot be read. */
      memoryLimit: (name: string) => {
        const said = query("inspect", "-f", "{{.HostConfig.Memory}}", name);
        return /^\d+$/.test(said) ? Number(said) : NaN;
      },
      /** Raise it, live: swap stays what `--memory` alone gives at create,
       *  as much again, or docker refuses a ceiling above the old swap. */
      raiseMemory: (name: string, bytes: number) =>
        effect("update", "--memory", String(bytes), "--memory-swap", String(2 * bytes), name),
      /** The same verdict the shared dind's healthcheck gives -- one script,
       *  pointed at this dind's socket. 0 healthy, 1 booting, 2 wedged. */
      health: (name: string) =>
        run.status(
          [
            "exec",
            "-e",
            "DESOLATE_INNER_SOCKET=/run/dind-sock/docker.sock",
            name,
            "sh",
            "/desolate-health/inner-health.sh",
          ],
          { quiet: true, timeoutMs: 10_000 },
        ),
      /** Names of every project dind, running or not. */
      all: (labelKey: string) =>
        nonEmptyLines(query("ps", "-a", "--filter", `label=${labelKey}`, "--format", "{{.Names}}")),
      /** Is a devcontainer up inside it -- somebody's editor, so not idle?
       *  Asked of the dind's own daemon, through the alias its entrypoint
       *  links; "" (no answer) reads as in use, which never evicts. */
      hostsDevcontainer: (name: string) =>
        // Bounded inside the dind: a wedged daemon must not wedge the supervisor.
        query(
          "exec",
          name,
          "timeout",
          "5",
          "docker",
          "ps",
          "-q",
          "--filter",
          `label=${IDENTITY_LABELS.workspace}`,
        ) !== "" ||
        query("exec", name, "timeout", "5", "docker", "info", "--format", "ok") !== "ok",
      /** `docker stats` MemUsage per name, e.g. "490.2MiB / 15.6GiB". */
      memoryUsage: (names: string[]) =>
        names.length
          ? nonEmptyLines(
              query("stats", "--no-stream", "--format", "{{.Name}}\t{{.MemUsage}}", ...names),
            )
          : [],
      /** Its address on one network, "" when it has none there. */
      address: (name: string, network: string) =>
        query("inspect", "-f", `{{with index .NetworkSettings.Networks "${network}"}}{{.IPAddress}}{{end}}`, name),
    },
    /** KiB a volume holds, read by a helper with no network; undefined when
     *  it could not be read (no such volume, or no helper image). */
    volumeKib: (helperImage: string, volumeName: string) => {
      const kib = Number.parseInt(
        // Bounded: the supervisor asks this on its one event loop, and a
        // project can fill its own store with as many inodes as it likes.
        query("run", "--rm", "--network", "none", "-v", `${volumeName}:/v:ro`, helperImage, "timeout", "30", "du", "-sk", "/v"),
        10,
      );
      return Number.isFinite(kib) ? kib : undefined;
    },
    /** Run a throwaway helper container against one volume. */
    inVolume: (
      helperImage: string,
      volumeName: string,
      target: string,
      argv: string[],
    ) =>
      run.status(
        ["run", "--rm", "-v", `${volumeName}:${target}`, helperImage, ...argv],
        { quiet: true },
      ),
    relay: {
      /** Mac:hostPort -> (daemon #0 range publish) -> dind ns:hostPort ->
       *  (this relay's publish on daemon #1) -> socat -> devcontainer IP.
       *  The relay joins the devcontainer's own network so `ip` is routable.
       *
       *  NO RESTART POLICY, deliberately. What this starts is socat pointed at
       *  an ADDRESS, read once when the relay was created, and that address
       *  means something only while the devcontainer it came from is up on that
       *  network. `unless-stopped` outlived both: on a daemon restart docker
       *  brought every relay back BEFORE -- and independently of -- the
       *  devcontainers they dial, so each one failed, restarted and added its
       *  own churn to the startup reconciliation; and a devcontainer recreated
       *  on a different address left the old relay forwarding a host port to
       *  whatever now holds the old one, which is worse than a dead port.
       *  Nothing needs the policy: `--stop` removes a target's relays and every
       *  start replaces them. */
      start: (spec: {
        image: string;
        name: string;
        label: string;
        network: string;
        hostPort: number;
        targetIp: string;
        targetPort: number;
        /** On a project daemon a dev server may be a compose SIBLING publishing
         *  on the dind rather than a process in the devcontainer. With this
         *  set, a connection the devcontainer REFUSES goes on to this address
         *  (the dind itself, from the relay's network) at the same port --
         *  decided at connect, before any byte is read, so nothing is lost.
         *  Measured: refused-then-sibling in ~45 ms, a serving devcontainer
         *  wins, a request body survives. */
        fallbackIp?: string;
      }) =>
        effect(
          "run",
          "-d",
          "--name",
          spec.name,
          "--label",
          spec.label,
          "--network",
          spec.network,
          "-p",
          `${spec.hostPort}:${spec.hostPort}`,
          spec.image,
          `tcp-listen:${spec.hostPort},fork,reuseaddr`,
          spec.fallbackIp === undefined
            ? `tcp:${spec.targetIp}:${spec.targetPort}`
            : relayWithFallback(spec.targetIp, spec.fallbackIp, spec.targetPort),
        ),

      /** True when something answers through this relay's own listener.
       *
       *  Runs INSIDE the relay, over the inner daemon's unix socket, because
       *  the orchestrator has no IP path to the container world -- that is the
       *  containment boundary, and a probe that needs to cross it is a probe
       *  that fails as soon as the boundary is real.
       *
       *  Any status line counts, 401 and 403 included: the editor answers
       *  tokenless requests with one, and the question here is whether it
       *  answered at all. socat is the fallback because it is the one program
       *  the relay image is guaranteed to carry; a bare TCP connect proves
       *  less, but proves it without depending on the image's busybox. */
      answers: (name: string, port: number) =>
        run.status(
          [
            "exec",
            name,
            "sh",
            "-c",
            `if command -v wget >/dev/null 2>&1; then ` +
              `wget -S -O /dev/null -T 2 http://127.0.0.1:${port}/ 2>&1 | grep -q 'HTTP/'; ` +
              `else socat -T 2 /dev/null TCP:127.0.0.1:${port}; fi`,
          ],
          { quiet: true },
        ) === 0,
    },
  };
};

export type Docker = ReturnType<typeof createDocker>;
