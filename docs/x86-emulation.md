# x86 emulation on an Apple Silicon VM (issue #37)

**Status: provisioning, preflight and docs are implemented. Equivalence with real x86 is NOT yet demonstrated, and nothing here has been run on an aarch64 Colima VM.** It was written in a devcontainer with no VM, no nested docker and no x86 hardware.

## What was built
- `release/vm/install-binfmt.sh` (called from `vm/install.sh`, aarch64 only): installs `qemu-user-static`, registers `x86_64`, `i386`, `i486` in the VM's `binfmt_misc` with the `F` flag, persists them in `/etc/binfmt.d`, and **reads the kernel's registry back** (enabled, `F`, right interpreter), exiting 1 otherwise. Registration happens in the human-run CLI; no container is privileged. Tests: `tests/static/23-binfmt.sh`.
- Preflight 6b runs `alpine uname -m` for `linux/amd64` and `linux/386` on the *inner* (sysbox) daemon, the daemon agents use.
- `release/emulation-equivalence.sh` + `.github/workflows/x86-reference.yml`: generate the v86_64 fixtures on real x86 (reference) and under emulation, then diff, refusing a clean result unless sensitive fixtures exist. The paths inside v86_64 (`tests/nasm/...`) are assumed from the issue and must be checked against that repo.

## Open question 2: does sysbox see the VM's binfmt_misc? (unverified)
Reasoned, not measured. binfmt_misc registrations are kernel-global before Linux 6.7. From 6.7 it is per user namespace: a container in its own userns gets an own (empty) instance, but lookups also consult the parent namespaces' instances, so a registration made in the init namespace with `F` should still apply to the sysbox dind and its children, and the interpreter is already open so it needs no file in the container. Preflight 6b is the check that settles it on the real VM; if it fails with `exec format error` while the VM has the registration, this assumption is wrong and the finding must be recorded here.

## Rosetta
`vmType: vz` + Rosetta is faster but x86_64 only: no i386, so it cannot run the `elf_i386` tests. It can coexist with qemu in principle (different binfmt names; Colima registers Rosetta as `rosetta`, which would take x86_64 first), but that would send x86_64 to Rosetta and only i386 to qemu, mixing two different inexactness profiles. Not adopted.

## Equivalence evidence (required, outstanding)
To produce: run the `x86-reference` workflow with a v86_64 sha; on the VM run `V86_COMMIT=<sha> release/emulation-equivalence.sh gen emu --platform linux/amd64`; `release/emulation-equivalence.sh diff ref emu`; classify each difference. Until then AGENTS.md tells agents not to treat emulated fixtures as hardware truth.
