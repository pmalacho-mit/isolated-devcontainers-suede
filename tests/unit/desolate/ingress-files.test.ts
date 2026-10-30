/// <reference types="node" />
// The ports/ directory, from the side that writes it.
//
// Every start, on every daemon, allocates host ports out of this one
// directory, and a target's saved map outlives its stop. So the failures are
// two targets believing in the same port: one start's claim silently taking
// another's, or one target's stop or purge deleting the forward another
// target has since been given. Both are exercised here on a real directory.

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { ingressDirectory, ingressFile, ownedForwards } from "../../../release/vscode-image/ingress-files.ts";

let directory = "";
beforeEach(() => (directory = fs.mkdtempSync(path.join(os.tmpdir(), "ingress-files-"))));
afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

const content = (port: number) => fs.readFileSync(path.join(directory, String(port)), "utf8");
const exists = (port: number) => fs.existsSync(path.join(directory, String(port)));
const one = (port: number) => new Map([["editor", port]]);

describe("a port is claimed by one target", () => {
  test("a claim writes the forward and names its owner", () => {
    const files = ingressDirectory(directory);
    assert.equal(files.claim(8080, "desolate-dind", "acme"), true);
    assert.equal(content(8080), "desolate-dind:8080 acme\n");
    assert.equal(files.ownerOf(8080), "acme");
  });

  test("a second target's claim on it fails, and changes nothing", () => {
    const files = ingressDirectory(directory);
    files.claim(8080, "desolate-dind", "acme");
    assert.equal(files.claim(8080, "desolate-dind-other", "other"), false);
    assert.equal(content(8080), "desolate-dind:8080 acme\n");
  });

  test("its owner's claim again is a rewrite: a new file, which the ingress reopens", () => {
    const files = ingressDirectory(directory);
    files.claim(8080, "desolate-dind", "acme");
    const before = fs.statSync(path.join(directory, "8080")).ino;
    assert.equal(files.claim(8080, "desolate-dind", "acme"), true);
    assert.notEqual(fs.statSync(path.join(directory, "8080")).ino, before);
  });

  test("nothing staged is left behind, whichever way a claim went", () => {
    const files = ingressDirectory(directory);
    files.claim(8080, "desolate-dind", "acme");
    files.claim(8080, "desolate-dind", "other");
    files.claim(8080, "desolate-dind", "acme");
    assert.deepEqual(fs.readdirSync(directory), ["8080"]);
  });

  test("a file that names no owner is nobody's to claim or remove", () => {
    fs.writeFileSync(path.join(directory, "8080"), "desolate-dind:8080\n");
    const files = ingressDirectory(directory);
    assert.equal(files.claim(8080, "desolate-dind", "acme"), false);
    files.release(8080, "acme");
    assert.throws(() => files.release(8080, ""), /cannot own a forward/);
    assert.throws(() => files.claim(8081, "desolate-dind", "a b"), /cannot own a forward/);
    assert.equal(exists(8080), true);
  });
});

describe("a target removes only its own forwards", () => {
  // The review's scenario: A stops, B is given A's old port, then A's saved map
  // -- which still says 8080 -- is withdrawn again.
  test("a second stop of A leaves B's forward on A's old port", () => {
    const files = ingressDirectory(directory);
    files.claim(8080, "desolate-dind", "A");
    files.withdraw(one(8080), "A");
    assert.equal(files.claim(8080, "desolate-dind", "B"), true);
    files.withdraw(one(8080), "A");
    assert.equal(content(8080), "desolate-dind:8080 B\n");
  });

  test("A restarting on a new port does not release the old one from B", () => {
    const files = ingressDirectory(directory);
    files.claim(8080, "desolate-dind", "B");
    assert.deepEqual(files.publish(one(8080), one(8081), "desolate-dind", "A"), []);
    assert.equal(content(8080), "desolate-dind:8080 B\n");
    assert.equal(content(8081), "desolate-dind:8081 A\n");
  });

  test("a publish over a port another target holds says so, and leaves it", () => {
    const files = ingressDirectory(directory);
    files.claim(8081, "desolate-dind", "B");
    assert.deepEqual(files.publish(new Map(), one(8081), "desolate-dind", "A"), [8081]);
    assert.equal(content(8081), "desolate-dind:8081 B\n");
  });

  test("its own, it does remove", () => {
    const files = ingressDirectory(directory);
    files.claim(8080, "desolate-dind", "A");
    files.claim(8081, "desolate-dind", "A");
    files.publish(new Map([["editor", 8080], ["5173", 8081]]), one(8080), "desolate-dind", "A");
    assert.equal(exists(8081), false, "the label it no longer has");
    files.withdraw(one(8080), "A");
    assert.equal(exists(8080), false);
  });
});

describe("which forwards are a target's own", () => {
  test("those whose file names it, and only files named as ports", () => {
    const entries = new Map([
      ["8080", ingressFile.format("desolate-dind", 8080, "A")],
      ["8081", ingressFile.format("desolate-dind", 8081, "B")],
      ["8082", "desolate-dind:8082\n"],
      [".8083.123", ingressFile.format("desolate-dind", 8083, "A")],
    ]);
    assert.deepEqual([...ownedForwards(entries, "A")], [8080]);
  });
});
