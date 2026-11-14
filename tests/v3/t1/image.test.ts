// T1. What tells a VM is older than this desolate (host/image.ts): the image's fingerprint
// moves with every input of provision.sh and nothing else; a VM's stamp is read back from
// what provision.sh writes; and a VM whose share of the release is another checkout is found
// file by file.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { codeFiles, differing, imageFingerprint, sha256, stampOf } from "../../../release/host/image.ts";

const RELEASE = path.resolve(import.meta.dirname, "../../../release");

/** A copy of the release's image inputs and some code, to change one at a time. */
const fixture = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "desolate-image-"));
  for (const file of ["image/provision.sh", "pins.env", "image/locks/mitmproxy.txt", "root/rootd.ts", "shared/names.ts", "workspace/start.sh"]) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.copyFileSync(path.join(RELEASE, file), path.join(dir, file));
  }
  return dir;
};

describe("T1 the image's fingerprint", () => {
  it("is 16 hex, the same for the same inputs", () => {
    assert.match(imageFingerprint(), /^[0-9a-f]{16}$/);
    assert.equal(imageFingerprint(), imageFingerprint());
    const dir = fixture();
    assert.equal(imageFingerprint(dir), imageFingerprint(dir));
  });

  it("moves with provision.sh, pins.env and a lock; not with the code VMs run from their share", () => {
    const dir = fixture();
    const before = imageFingerprint(dir);
    fs.appendFileSync(path.join(dir, "root/rootd.ts"), "\n// a change to code, not to the image\n");
    assert.equal(imageFingerprint(dir), before, "control: code is not the image");
    for (const file of ["image/provision.sh", "pins.env", "image/locks/mitmproxy.txt"]) {
      const original = fs.readFileSync(path.join(dir, file));
      fs.appendFileSync(path.join(dir, file), "\n# changed\n");
      assert.notEqual(imageFingerprint(dir), before, `${file} is an input of the image`);
      fs.writeFileSync(path.join(dir, file), original);
      assert.equal(imageFingerprint(dir), before);
    }
    fs.writeFileSync(path.join(dir, "image/locks/new.lock"), "x\n");
    assert.notEqual(imageFingerprint(dir), before, "a new lock is an input too");
  });
});

describe("T1 a VM's stamp", () => {
  it("is what provision.sh wrote, or null when it wrote none", () => {
    assert.equal(stampOf("kind=vm\nnode=v22.18.0\nbuilt=2026-11-13T00:00:00Z\nimage=0123456789abcdef\n"), "0123456789abcdef");
    assert.equal(stampOf("kind=vm\nnode=v22.18.0\nbuilt=2026-11-13T00:00:00Z\n"), null, "an image from before stamps");
    assert.equal(stampOf("image=0123\n"), null);
    assert.equal(stampOf("image=0123456789abcdef; rm -rf /\n"), null);
    assert.equal(stampOf(""), null);
  });

  it("provision.sh writes the fingerprint it is given, and nothing that is not one", () => {
    const script = fs.readFileSync(path.join(RELEASE, "image/provision.sh"), "utf8");
    const line = script.split("\n").find((l) => l.includes("DESOLATE_IMAGE_FINGERPRINT"))!;
    assert.ok(line, "provision.sh stamps the image");
    const run = (value: string) => {
      const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "desolate-stamp-")), "image-info");
      execFileSync("bash", ["-c", line.replaceAll("/opt/desolate/image-info", out)], { env: { ...process.env, DESOLATE_IMAGE_FINGERPRINT: value } });
      return fs.existsSync(out) ? fs.readFileSync(out, "utf8") : "";
    };
    assert.equal(stampOf(run("0123456789abcdef")), "0123456789abcdef");
    assert.equal(run("x; touch /tmp/no"), "");
    assert.equal(run(""), "");
  });
});

describe("T1 the code a VM runs", () => {
  it("is this release's when every file's hash matches; each other file is named", () => {
    const dir = fixture();
    const files = codeFiles(dir);
    assert.deepEqual(files, ["root/rootd.ts", "shared/names.ts", "workspace/start.sh"]);
    const sums = files.map((file) => `${sha256(path.join(dir, file))}  ${file}`).join("\n");
    assert.deepEqual(differing(sums, dir), [], "control: the same files");
    fs.appendFileSync(path.join(dir, "root/rootd.ts"), "\n// newer\n");
    assert.deepEqual(differing(sums, dir), ["root/rootd.ts"]);
    assert.deepEqual(differing(sums.split("\n").slice(0, -1).join("\n"), dir), ["root/rootd.ts", "workspace/start.sh"], "a file the VM lacks differs");
    assert.deepEqual(differing("", dir), files, "a VM that answered nothing runs none of it");
  });

  it("covers the release's own code", () => {
    const files = codeFiles();
    for (const file of ["root/rootd.ts", "root/start.sh", "shared/names.ts", "workspace/start.sh"]) assert.ok(files.includes(file), file);
    assert.ok(!files.some((file) => file.startsWith("host/")), "the host's code runs on the host, from this checkout");
  });
});
