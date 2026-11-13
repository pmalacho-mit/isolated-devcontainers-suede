# Intel Macs: what it takes (investigated 2026-11-13, on the M1; not yet run on Intel)

**Verdict: viable without changing the stack.** desolate's Mac backend is Lima with
Virtualization.framework (`vz`), which runs x86_64 Linux guests on Intel Macs as it runs
arm64 ones on Apple silicon (macOS 13 or newer). Nothing in desolate is Apple-silicon-only;
what is missing is a run on an Intel Mac to prove the boundaries there.

## What is already architecture-aware

| | how |
|---|---|
| the VM image | `host/vm/lima.ts` picks `x86_64` or `aarch64` from the host (`os.arch()`), and the base comes from Lima's `ubuntu-24.04` template, which pins both architectures' images by digest |
| node and VSCodium in the image | `pins.env` pins both: `NODE_SHA256_x64`, `VSCODIUM_SHA256_x64`; `image/provision.sh` picks by `uname -m` |
| mitmproxy (the secrets proxies) | `image/locks/mitmproxy.txt` hashes every published file, both architectures' wheels among them |
| the devcontainer CLI | pure JavaScript, one lock |
| a workspace's confinement | `sandbox-exec` on Lima's host process: macOS's own, architecture-independent |
| the defaults for a workspace's size | from the Mac's own cores and memory (an Intel Mac often has fewer: 2 CPUs, 3-4 GiB) |
| devcontainers | the projects' own images, run natively as x86_64 (on Apple silicon, an amd64-only image needs emulation; on Intel, an arm64-only one would) |

## What has changed for it (`mac/intel`)

- `desolate doctor` checks macOS 13 or newer (Virtualization.framework with virtiofs needs it,
  on either architecture), and on an Intel Mac says the boundaries are not yet proven there.

## To prove it, on an Intel Mac (about 30 minutes)

```bash
brew install lima node gh            # Lima 2.3 or newer
git clone --branch v3 https://github.com/pmalacho-mit/isolated-devcontainers-suede && cd isolated-devcontainers-suede
npm install --legacy-peer-deps
make test                            # T1: no VMs
mkdir -p ~/t && TMPDIR=$HOME/t tests/v3/run.sh t4    # the boundaries, on real VMs: needs Docker (Colima) for the stand-in forge
```

T4 is the same 14 tests that pass on the M1: read-only shares and forced egress against root
in the VM (TCP, UDP, DNS and ICMP), no path between domains, an offer and hostile content over
a real share, the editor, a secret. If all 14 pass, change "an Intel Mac is not supported" in
`release/docs/getting-started.md` and the doctor note above.

## What to watch for

- **ICMP.** On Apple silicon, Lima 2.1 let a confined guest's pings out; 2.3 does not
  (measured). The same Lima code runs on Intel, but this was never measured there: T4's
  egress test sends ICMP.
- **Boot time and memory.** Intel Macs have less memory and Virtualization.framework boots
  slower on them; the size defaults adapt, and `DESOLATE_PROGRESS=1 desolate up` shows where
  a start's time goes.
- **Devcontainer images** that publish only arm64 builds (rare) would need emulation, which
  Virtualization.framework does not offer x86_64 guests.
