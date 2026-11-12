// T1. The Lima backends do not take a VM's shares on trust: a VM is used only once every
// share in its spec is mounted, and (on vz) mounted read-only exactly where the spec says.
// Found on the M1: ssh answers before the last virtiofs share is mounted, and the first
// command saw a bare mount point (release/docs/incidents.md).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { unmounted } from "../../../release/host/vm/lima.ts";

const shares = [
  { guest: "/desolate/release", writable: false },
  { guest: "/workspaces", writable: true },
  { guest: "/desolate/mirrors/acme/my widgets.git", writable: false },
];
const line = (source: string, where: string, type: string, options: string) => `${source} ${where} ${type} ${options} 0 0`;
const all = [
  line("/dev/vda1", "/", "ext4", "rw,relatime"),
  line("lima-1", "/desolate/release", "virtiofs", "ro,relatime"),
  line("lima-2", "/workspaces", "virtiofs", "rw,relatime"),
  line("lima-3", "/desolate/mirrors/acme/my\\040widgets.git", "virtiofs", "ro,relatime"),
].join("\n");

describe("T1 lima: a VM's shares, checked before it is used", () => {
  it("control: every share mounted as its spec says is ready", () => {
    assert.deepEqual(unmounted(all, shares, "virtiofs", true), { missing: [], wrong: [] });
  });

  it("a share not mounted yet is missing (the race on vz), and so is one of another filesystem at its path", () => {
    const early = all.split("\n").filter((l) => !l.includes("widgets")).join("\n");
    assert.deepEqual(unmounted(early, shares, "virtiofs", true).missing, ["/desolate/mirrors/acme/my widgets.git"]);
    const other = all.replace("lima-2 /workspaces virtiofs", "tmpfs /workspaces tmpfs");
    assert.deepEqual(unmounted(other, shares, "virtiofs", true).missing, ["/workspaces"]);
    assert.deepEqual(unmounted("", shares, "virtiofs", true).missing.length, 3);
  });

  it("a read-only share mounted read-write, or the reverse, is wrong; the last mount at a path is the one that counts", () => {
    const rw = all.replace("/desolate/release virtiofs ro,relatime", "/desolate/release virtiofs rw,relatime");
    assert.deepEqual(unmounted(rw, shares, "virtiofs", true).wrong, ["/desolate/release is mounted read-write"]);
    const ro = all.replace("/workspaces virtiofs rw,relatime", "/workspaces virtiofs ro,relatime");
    assert.deepEqual(unmounted(ro, shares, "virtiofs", true).wrong, ["/workspaces is mounted read-only"]);
    const over = `${all}\n${line("lima-1", "/desolate/release", "virtiofs", "rw,relatime")}`;
    assert.deepEqual(unmounted(over, shares, "virtiofs", true).wrong, ["/desolate/release is mounted read-write"], "a second mount over the first is what programs see");
    assert.deepEqual(unmounted(rw, shares, "virtiofs", false).wrong, [], "without flags (qemu, where QEMU enforces read-only), only presence is checked");
  });
});
