# Runbook: the inner daemon wedges and nothing can be killed

**Symptom.** `./cli.sh observe docker ps` still answers, but `docker stop` / `docker rm`
on any devcontainer hangs forever. `docker` inside a devcontainer that has the
`docker-in-docker` feature can no longer reach its own daemon. The only known fix
so far is `./cli.sh down && ./cli.sh up`.

**Read this first, act second.** The evidence that identifies the cause lives in
dind's process table and the VM's kernel state, and `down` destroys both. Ten
minutes of capture is the difference between fixing this and restarting again
next week. [Recovery](#recovery-ladder) is at the bottom and is cheap once the
capture is done.

---

## Working hypothesis

Four levels share one kernel:

```
Colima VM  ->  desolate-dind (sysbox-runc)  ->  devcontainer (runc, --privileged
               dockerd/containerd/runc          when it uses the DinD feature)
                                             ->  the feature's own dockerd /
                                                 containerd / buildkitd
```

The mechanism is already written down in `release/vscode-image/desolate.ts`, in
the `shadowBaseImages` comment:

> a container stopped mid-build cannot tear its mount namespace down, so its init
> never reports an exit and the daemon supervising it hangs waiting for one

That comment scopes it to shadow-image builds. The mechanism is not specific to
them. **Any** nested daemon activity in flight when the level-2 container is
stopped can leave a task the level-1 daemon can never reap — a nested
`containerd-shim` or `runc` stuck in `D` state, or overlay mounts still held open
inside the devcontainer's mount namespace. runc sends SIGKILL, the kernel cannot
deliver it to an uninterruptible task, PID 1 never exits, dind's shim waits
forever.

**Why one container takes the whole daemon with it.** dockerd's stop/remove path
takes the container lock and then libnetwork's controller lock to release the
sandbox. A container blocked in that path holds locks every subsequent
create/start/stop contends for. `docker info` reads cached state and keeps
answering throughout — which is why dind's healthcheck stays green and compose
never restarts anything.

**Why the nested daemon dies too.** The DinD feature starts `dockerd` once from
its init script and does not supervise it. One transient kill (OOM, fd
exhaustion) is permanent for that container's lifetime. And a daemon killed
mid-mount is a plausible source of the untearable mount namespace above, so the
two symptoms may be one event.

**What the restart tells us.** A plain `down && up` *without* `-v` fixes it, so
the bad state is not on disk — `dind-sysbox-data` and every
`dind-var-lib-docker-<id>` survive. It is in dind's process table and the
kernel's task list. That rules out disk/inode exhaustion as the primary cause
unless a capture says otherwise.

---

## Capture

Run this from the Mac, before touching anything. It writes one timestamped file
and never blocks for more than a few seconds per probe.

```bash
#!/usr/bin/env bash
# save as tests/probes/capture-wedge.sh, run when the stack is wedged
OUT="wedge-$(date +%Y%m%d-%H%M%S).log"
exec > >(tee "$OUT") 2>&1
PROFILE="${COLIMA_PROFILE:-desolate}"
vm() { colima ssh -p "$PROFILE" -- "$@"; }

echo "=== 1. uninterruptible tasks in the VM (THE smoking gun) ==="
vm ps -eo pid,ppid,stat,wchan:32,comm,args | awk 'NR==1 || $3 ~ /D/'

echo; echo "=== 2. kernel: blocked tasks, OOM kills, overlayfs/fuse errors ==="
vm dmesg -T | tail -80

echo; echo "=== 3. does info answer while writes hang? (lock hypothesis) ==="
timeout 5  ./cli.sh observe docker info >/dev/null 2>&1 \
  && echo "info: OK (daemon answering reads)" || echo "info: FAILED/TIMEOUT"
timeout 20 ./cli.sh observe docker run --rm alpine true >/dev/null 2>&1 \
  && echo "write path: OK" || echo "write path: WEDGED"

echo; echo "=== 4. inner container states (look for Removal In Progress) ==="
timeout 10 ./cli.sh observe docker ps -a --format \
  'table {{.Names}}\t{{.Status}}\t{{.RunningFor}}'

echo; echo "=== 5. dockerd goroutine dump -- names the held lock ==="
docker exec desolate-dind kill -USR1 1 2>/dev/null && sleep 2
docker logs desolate-dind 2>&1 | tail -5   # dockerd logs the path it wrote
# then, using the filename from above:
#   docker exec desolate-dind cat /var/run/docker/goroutine-stacks-<ts>.log

echo; echo "=== 6. dind internals: fds, tasks, disk ==="
docker exec desolate-dind sh -c '
  echo "tasks under pid1: $(ls /proc/1/task 2>/dev/null | wc -l)"
  echo "open fds pid1   : $(ls /proc/1/fd 2>/dev/null | wc -l)"
  df -h  /var/lib/docker
  df -ih /var/lib/docker
  ps -eo pid,stat,comm | awk "\$2 ~ /D/"
' 2>&1

echo; echo "=== 7. VM-global limits and pressure ==="
vm sh -c '
  echo "inotify instances : $(cat /proc/sys/fs/inotify/max_user_instances)"
  echo "inotify watches   : $(cat /proc/sys/fs/inotify/max_user_watches)"
  echo "file-nr           : $(cat /proc/sys/fs/file-nr)"
  echo "pids             : $(ps -e --no-headers | wc -l)"
  free -m; uptime
'

echo; echo "=== 8. mount count inside dind (untearable namespaces leak these) ==="
docker exec desolate-dind sh -c 'wc -l < /proc/mounts; grep -c overlay /proc/mounts'

echo; echo "wrote $OUT"
```

Then, inside one affected devcontainer (if `docker exec` still works — it may
not, since it goes through the wedged daemon):

```bash
timeout 15 ./cli.sh observe docker exec <devcontainer> sh -c \
  'ps -eo pid,stat,comm | grep -E "dockerd|containerd|buildkit"; ls -l /var/run/docker.sock'
```

Absent `dockerd` means it **died**. Present `dockerd` with a socket that accepts
but never answers means it **hung**. These are different bugs.

---

## Reading the capture

| Evidence | Conclusion |
| --- | --- |
| Any `D`-state task in §1 or §6 | Confirmed: unreapable task. The `wchan` names the stuck subsystem (`overlayfs`, `fuse`, `loop`, `rpc`). This is the primary hypothesis. |
| §3 shows `info: OK` + `write path: WEDGED` | Confirmed: lock contention, not a dead daemon. The healthcheck is blind to this. |
| §2 shows `task blocked for more than 120 seconds` | Same conclusion as §1, with a stack trace attached. |
| §2 shows `Out of memory: Killed process ... dockerd/buildkitd` | The nested daemon was OOM-killed. Root cause is unbounded memory, not teardown ordering. |
| §5 stacks pile up in `libnetwork` / `(*Controller)` | Confirms the sandbox-release lock as the choke point. |
| §6 shows `/var/lib/docker` at 100% or inodes exhausted | Disk after all — but then `down && up` should NOT have fixed it, so treat as a second, independent problem. |
| §7 shows `file-nr` near max, or inotify instances low (128 default) | Shared-kernel exhaustion. Nested daemons multiply this; raise in `vm/install.sh`. |
| §8 mount count growing across incidents | Leaked mount namespaces from prior wedges. |

---

## Recovery ladder

Cheapest first. Stop at the first one that works, and record which in the log below.

1. `timeout 30 ./cli.sh observe docker rm -f <the stuck container>` — occasionally
   clears if only that container's lock is held.
2. `docker restart desolate-dind` — kills every devcontainer but leaves the
   editor, keyring, orchestrator, and the VM's nftables rules alone. Much less
   disruptive than a full `down`. This clears exactly the state that is bad.
3. `./cli.sh down && ./cli.sh up` — the current workaround. Note: `down` without
   `-v` preserves all project data.
4. `colima restart -p desolate` — only if a `D`-state task is holding a kernel
   resource that survives dind teardown. If you get here, note it: it means the
   leak escaped the sysbox boundary, which is a much more interesting bug.

Never use `-v`. It deletes every project.

---

## Fixes to consider

Roughly by value. None are implemented yet.

1. **Quiesce level 3 before stopping level 2.** Direct fix for the mechanism.
   In `docker.ts`, before `container.stop(cid)`, if `hasDockerCli(cid)`:
   `docker ps -aq | xargs -r docker rm -f; pkill -TERM dockerd`, then wait for
   the nested mounts to drop before stopping the outer container. Today
   `container.stop` has no timeout and no pre-stop hook. The mount namespace can
   only be torn down after the nested daemon has unmounted its overlays;
   stopping the outer container first is what creates the unreapable task.
2. **One dind per privileged project.** `tests/probes/nested-sysbox.sh` already
   reaches this in its failure branch as a security argument. It is equally a
   reliability argument, and the stronger one: today a single agent's bad
   teardown takes out every project because they share one daemon and one lock
   set. Separate dinds turn a stack-wide outage into a single-project one, and
   recovery becomes `docker rm -f` on one sysbox container.
3. **Make the healthcheck detect this.** `docker info` cannot. Exercise the write
   path under a timeout, or alarm on `docker container ls --filter status=removing`
   being non-empty.
4. **Bound resources.** `mem_limit` and `pids_limit` on `dind`; per-devcontainer
   `--memory`, `--pids-limit`, `--cpus` injected by the broker — `policy.ts`
   already validates the spec, so it is the natural place to also impose limits
   rather than only reject. Raise `fs.inotify.max_user_instances`,
   `max_user_watches`, and `fs.file-max` in `vm/install.sh`.
5. **`--default-ulimit` for the nested daemon.** The containerd 2.x `LimitNOFILE`
   regression handled at level 1 in `docker-compose.yml` recurs at level 3, where
   nothing passes the flag.
6. **Supervise the nested dockerd**, or at least detect that it died — the DinD
   feature starts it once and never restarts it.

---

## Occurrence log

Append one row per incident. The pattern across three of these will be worth more
than any single capture.

| Date | Capture file | What was running (agent? build? `--stop` mid-start?) | `D`-state? `wchan` | OOM? | Recovery step that worked |
| --- | --- | --- | --- | --- | --- |
| | | | | | |
