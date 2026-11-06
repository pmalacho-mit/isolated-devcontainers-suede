# x86 emulation on an Apple Silicon VM (issue #37)

**Status: provisioning, preflight and docs are implemented and have run on an aarch64 Colima VM (Ubuntu 24.04, kernel 6.8, sysbox 0.7.1): preflight 6b passes. Equivalence with real x86 was measured: emulation is NOT equivalent for v86_64's fixtures (1,038 of 16,529 differ under its own runner, every one with a named qemu cause); see [x86-equivalence-evidence.md](x86-equivalence-evidence.md).** First written in a devcontainer with no VM; the findings below came from the VM.

## What was built
- `release/vm/binfmt-register.sh` (POSIX sh): registers `x86_64`, `i386`, `i486` with the `F` flag in the binfmt_misc of **the user namespace it runs in**, probes that a native binary still execs after each entry, **reads the kernel's registry back** (enabled, `F`, right interpreter) and exits 1 -- undoing its own entries -- otherwise.
- `release/vm/install-binfmt.sh` (called from `vm/install.sh`, aarch64 only): installs `qemu-user-static`, **publishes** the two static interpreters and the registrar under `/var/lib/desolate-proxy/public/binfmt` (mounted read-only at `/desolate/binfmt` in every dind), and registers in the VM too (persisted in `/etc/binfmt.d`).
- Both dind entrypoints (`docker-compose.yml`, `vscode-image/docker.ts`) run `/desolate/binfmt/register.sh` before `dockerd`, so each dind has the entries in its own table. No container is privileged: a sysbox container is root in its own user namespace, which owns that table. Tests: `tests/static/23-binfmt.sh`.
- Preflight 6b runs `alpine uname -m` for `linux/amd64` and `linux/386` on the *inner* (sysbox) daemon, the daemon agents use.
- `release/emulation-equivalence.sh` (+ `release/emulation-equivalence/`, `.github/workflows/x86-reference.yml`): `gen ref` on real x86, `gen emu` on the aarch64 VM, `compare`. Both sides build v86_64's nasm tests at a pinned commit in `ubuntu:24.04` and record its `gen_fixtures.js` fixtures, plus the raw register bits and gdb single-step traces of the x87-transcendental tests. `compare` gives two verdicts per test: what v86_64's `run.js` would see (its 1e-7 x87 tolerance and EFLAGS / status-word masks), and byte-for-byte on the raw bits. References are compared with each other too; see "Equivalence evidence".

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

## Finding 3: gdb cannot trace under qemu-user (measured)
Inside a `linux/amd64` container, `gdb ./prog` fails with `ptrace: Function not implemented`: qemu-user runs the guest as part of its own process and implements no ptrace for it. v86_64's `gen_fixtures.js` is gdb-driven, so the emulated side runs each test under `qemu-i386-static -g PORT` (qemu's gdb server) and a native aarch64 `gdb-multiarch` attaches over TCP. Single-stepping (`stepi`) works that way. Two consequences for comparing with real x86, both handled in `release/emulation-equivalence/`:
- aarch64 gdb converts x87 values through a double for printing, and refuses outright the encodings MMX leaves in st0-7 (pseudo-NaNs, unnormals: "Invalid floating value found in program"). The emulated side prints st0-7 from their raw 80 bits with glibc's `%.100e` rules (`x87print.py`, checked against glibc 2.36 on 20 patterns including those encodings).
- The byte-for-byte comparison therefore uses gdb's `(raw 0x...)`, never printed decimals.

## Equivalence evidence
Inputs: v86_64 `c394574477b57eadfc859f593b4aecb08fa37cb6`, 16529 tests. Emulator: qemu-i386-static 8.2.2 (Ubuntu 24.04; the VM's is `1:8.2.2+ds-0ubuntu1.18`).

```sh
release/emulation-equivalence.sh gen emu emu        # on the VM (a devcontainer)
release/emulation-equivalence.sh gen ref ref-intel  # on real x86 (and the x86-reference workflow)
release/emulation-equivalence.sh compare emu ref-amd ref-intel
```

Results ([x86-equivalence-evidence.md](x86-equivalence-evidence.md)), against an Intel Xeon Gold 6140 and an AMD EPYC 9V74:
- **The two real CPUs are bit-identical on all 16,529 fixtures**, so no difference is hardware-dependent.
- **Emulated:** 15,491 pass and 1,038 fail under v86_64's `run.js` rules. 920 of the failures are x87 stack faults, which qemu never reports. 56 are `FCOMI`-family flags. 58 are instruction decoding (`F6`/`F7 /1`, the register forms of memory-only SSE moves, `0F 18` hints), plus 16-bit `ENTER`, `FSAVE` reserved bits, `fprem` C3 and the `fyl2xp1` domain.
- **Raw-only differences:**
  - MMX writes don't set the x87 exponent field.
  - Fault frames are missing RF.
  - C1, DE and `MXCSR.DE` flags are missing.
  - `fsin`/`fcos`/`fptan`/`fsincos` are computed in host double precision.
- **gdb single-stepping through qemu's gdb server is reliable.**

AGENTS.md therefore tells agents to use emulation to build, run and debug, and never as a source of fixtures.

Re-running: the commands above, then `compare` with both references. Three harness failures were found and fixed along the way, all on the emulated side:
- A shared gdb port let a test be recorded with its predecessor's state. Ports are now per test.
- Under 8-way parallelism, about 0.5% of gdb connections timed out. Those tests are retried serially.
- awk's escape processing broke the injected gdb `printf`. The text is now passed through `ENVIRON`.
