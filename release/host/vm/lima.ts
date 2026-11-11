// The Lima backends: `qemu` (Linux; KVM where there is /dev/kvm, TCG where there is not) and
// `vz` (macOS Virtualization.framework, the product backend). One implementation: Lima is the
// same tool on both, and only the VM type and the egress mechanism differ.
//
// PLACEHOLDER while the fake backend carries Phase 1; filled in with tier T3.
import type { Backend } from "./types.ts";

export const limaBackend = (kind: "qemu" | "vz"): Backend => {
  throw new Error(`the ${kind} backend is not implemented yet`);
};
