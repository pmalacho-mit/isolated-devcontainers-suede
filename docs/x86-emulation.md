# x86 emulation on an Apple Silicon VM (issue #37)

**Status: provisioning, preflight and docs are implemented and have run on an aarch64 Colima VM (Ubuntu 24.04, kernel 6.8, sysbox 0.7.1): preflight 6b passes. Equivalence with real x86 is NOT yet demonstrated.** First written in a devcontainer with no VM; the two findings below came from the VM.

## What was built
- `release/vm/binfmt-register.sh` (POSIX sh): registers `x86_64`, `i386`, `i486` with the `F` flag in the binfmt_misc of **the user namespace it runs in**, probes that a native binary still execs after each entry, **reads the kernel's registry back** (enabled, `F`, right interpreter) and exits 1 -- undoing its own entries -- otherwise.
- `release/vm/install-binfmt.sh` (called from `vm/install.sh`, aarch64 only): installs `qemu-user-static`, **publishes** the two static interpreters and the registrar under `/var/lib/desolate-proxy/public/binfmt` (mounted read-only at `/desolate/binfmt` in every dind), and registers in the VM too (persisted in `/etc/binfmt.d`).
- Both dind entrypoints (`docker-compose.yml`, `vscode-image/docker.ts`) run `/desolate/binfmt/register.sh` before `dockerd`, so each dind has the entries in its own table. No container is privileged: a sysbox container is root in its own user namespace, which owns that table. Tests: `tests/static/23-binfmt.sh`.
- Preflight 6b runs `alpine uname -m` for `linux/amd64` and `linux/386` on the *inner* (sysbox) daemon, the daemon agents use.
- `release/emulation-equivalence.sh` + `.github/workflows/x86-reference.yml`: generate the v86_64 fixtures on real x86 (reference) and under emulation, then diff, refusing a clean result unless sensitive fixtures exist. The paths inside v86_64 (`tests/nasm/...`) are assumed from the issue and must be checked against that repo.

## Finding 1: a VM-level registration does not reach sysbox containers (measured)
The first version registered in the VM only, reasoning that from Linux 6.7 lookups fall back to the parent namespace's table. That fallback exists, but only for a user namespace that has **not** mounted binfmt_misc itself: a mount creates an own, empty table for that namespace, which then shadows every ancestor's. sysbox mounts binfmt_misc in every container it starts (since 0.6.7, "binfmt_misc namespacing inside Sysbox containers (kernel 6.7+)"). Measured on the VM with the VM's `qemu-x86_64` entry correct:

```
$ docker exec desolate-dind sh -c 'grep binfmt_misc /proc/self/mountinfo; ls /proc/sys/fs/binfmt_misc'
530 583 0:58 / /proc/sys/fs/binfmt_misc rw,nosuid,nodev,noexec,relatime shared:387 - binfmt_misc binfmt_misc rw
register
status
$ docker exec desolate-orchestrator docker run --rm --platform linux/amd64 alpine uname -m
exec /bin/uname: exec format error
```

Registering the same entry *inside* dind (interpreter copied into dind, `F` flag, plain `docker exec -u 0`, no privilege) made the same `docker run` print `x86_64`. Hence the design above: the interpreters are published read-only into every dind and each dind registers them itself. Inner containers share dind's user namespace, so one registration per dind covers all of them. Kernel: [binfmt_misc: enable sandboxed mounts](https://lkml.rescloud.iu.edu/2112.2/00411.html); sysbox: [v0.6.7 notes](https://github.com/nestybox/sysbox/releases/tag/v0.6.7), [nestybox/sysbox#592](https://github.com/nestybox/sysbox/issues/592).

## Finding 2: the magic goes to the kernel as text, not bytes (measured)
`/proc/sys/fs/binfmt_misc/register` takes the magic and mask as the literal string `\x7fELF\x02...`; the kernel unquotes `\xHH` itself (`fs/binfmt_misc.c`, `unquote()`), and that unquoting stops at the first NUL byte. Writing pre-decoded bytes (`printf '%b'`) truncated the x86_64 magic to the 7-byte ELF64 prefix, every 64-bit ELF on the VM then matched, qemu (itself a 64-bit ELF) matched again, and `exec` of every native binary failed with ELOOP ("Too many levels of symbolic links") -- the VM was unusable until reboot. The registrar writes with `printf '%s'`, execs a native binary after each entry, and removes what it registered if that fails.

## Rosetta
`vmType: vz` + Rosetta is faster but x86_64 only: no i386, so it cannot run the `elf_i386` tests. It can coexist with qemu in principle (different binfmt names; Colima registers Rosetta as `rosetta`, which would take x86_64 first), but that would send x86_64 to Rosetta and only i386 to qemu, mixing two different inexactness profiles. Not adopted.

## Equivalence evidence (required, outstanding)
To produce: run the `x86-reference` workflow with a v86_64 sha; on the VM run `V86_COMMIT=<sha> release/emulation-equivalence.sh gen emu --platform linux/amd64`; `release/emulation-equivalence.sh diff ref emu`; classify each difference. Until then AGENTS.md tells agents not to treat emulated fixtures as hardware truth.
