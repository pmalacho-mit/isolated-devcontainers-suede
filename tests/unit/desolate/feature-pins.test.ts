/// <reference types="node" />
// Features pinned to the digest that was checked (feature-pins.ts, audit H2):
// a tag becomes the digest the CLI's resolver names for it, a project's own
// lockfile has the first word, and what cannot be pinned -- a tarball, a
// GitHub-releases id, a feature with dependencies -- is refused, with why.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { classify, FeaturePinError, parseRef, pinFeatures, unpinned, type Lockfile } from "../../../release/vscode-image/feature-pins.ts";

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);

/** A resolver that answers from a fixed lockfile, and records what it was asked. */
const resolver = (lock: Lockfile) => {
  const asked: Record<string, unknown>[] = [];
  const resolve = (features: Record<string, unknown>) => {
    asked.push(features);
    return lock;
  };
  return { resolve, asked };
};

describe("what an id is", () => {
  test("registry references, with a tag, a digest, or both", () => {
    assert.deepEqual(parseRef("ghcr.io/devcontainers/features/node:1"), { name: "ghcr.io/devcontainers/features/node", host: "ghcr.io", path: "devcontainers/features/node", tag: "1" });
    assert.deepEqual(parseRef(`ghcr.io/Guiyomh/features/vim@sha256:${A}`)?.digest, `sha256:${A}`);
    assert.equal(parseRef(`ghcr.io/x/y:1@sha256:${A}`)?.tag, "1");
    assert.equal(parseRef("localhost:5000/x/y:1"), undefined, "no dot: not a registry the CLI would treat as one");
    assert.equal(parseRef("owner/repo/feature:1"), undefined, "a GitHub owner, resolved through releases");
    assert.equal(parseRef("ghcr.io/onlyone:1"), undefined, "a registry path has a namespace");
    assert.equal(parseRef("ghcr.io/x/y@sha256:short"), undefined);
  });

  test("the kinds", () => {
    assert.equal(classify("ghcr.io/devcontainers/features/node:1"), "tag");
    assert.equal(classify(`ghcr.io/devcontainers/features/node@sha256:${A}`), "pinned");
    assert.equal(classify("https://example.com/f.tgz"), "tarball");
    assert.equal(classify("./features/mine"), "local");
    assert.equal(classify("owner/repo/feature:1"), "unknown");
  });
});

describe("pinning", () => {
  test("a tag becomes the digest the resolver names, the options kept, the order kept", () => {
    const { resolve, asked } = resolver({ features: {
      "ghcr.io/devcontainers/features/node:1": { version: "1.7.1", resolved: `ghcr.io/devcontainers/features/node@sha256:${A}`, integrity: `sha256:${A}` },
      "ghcr.io/guiyomh/features/vim:0": { version: "0.0.1", resolved: `ghcr.io/guiyomh/features/vim@sha256:${B}`, integrity: `sha256:${B}` },
    } });
    const features = { "ghcr.io/devcontainers/features/node:1": { version: "22" }, "ghcr.io/guiyomh/features/vim:0": {} };
    const pinned = pinFeatures(features, resolve);
    assert.deepEqual(pinned.features, {
      [`ghcr.io/devcontainers/features/node@sha256:${A}`]: { version: "22" },
      [`ghcr.io/guiyomh/features/vim@sha256:${B}`]: {},
    });
    assert.deepEqual(Object.keys(pinned.features), [`ghcr.io/devcontainers/features/node@sha256:${A}`, `ghcr.io/guiyomh/features/vim@sha256:${B}`]);
    assert.deepEqual(pinned.notes, [`ghcr.io/devcontainers/features/node:1 -> @${"a".repeat(12)}`, `ghcr.io/guiyomh/features/vim:0 -> @${"b".repeat(12)}`]);
    assert.deepEqual(asked, [features], "the resolver saw the declared features, once");
  });

  test("a digest already there is kept as written -- and the resolver still runs, for the dependencies only it sees", () => {
    const { resolve, asked } = resolver({ features: { [`ghcr.io/x/y@sha256:${A}`]: { resolved: `ghcr.io/x/y@sha256:${A}` } } });
    const pinned = pinFeatures({ [`ghcr.io/x/y@sha256:${A}`]: { o: 1 } }, resolve);
    assert.deepEqual(pinned, { features: { [`ghcr.io/x/y@sha256:${A}`]: { o: 1 } }, notes: [] });
    assert.equal(asked.length, 1);
  });

  test("the project's own lockfile has the first word on a tag's digest", () => {
    const { resolve } = resolver({ features: { "ghcr.io/x/y:1": { resolved: `ghcr.io/x/y@sha256:${A}` } } });
    const own: Lockfile = { features: { "ghcr.io/x/y:1": { resolved: `ghcr.io/x/y@sha256:${B}` } } };
    const pinned = pinFeatures({ "ghcr.io/x/y:1": {} }, resolve, own);
    assert.deepEqual(Object.keys(pinned.features), [`ghcr.io/x/y@sha256:${B}`]);
    assert.match(pinned.notes[0], /its lockfile's/);
  });

  test("  but only for the same feature: a lockfile naming another is ignored", () => {
    const { resolve } = resolver({ features: { "ghcr.io/x/y:1": { resolved: `ghcr.io/x/y@sha256:${A}` } } });
    const own: Lockfile = { features: { "ghcr.io/x/y:1": { resolved: `ghcr.io/evil/z@sha256:${C}` } } };
    assert.deepEqual(Object.keys(pinFeatures({ "ghcr.io/x/y:1": {} }, resolve, own).features), [`ghcr.io/x/y@sha256:${A}`]);
  });

  test("a resolver answer that names another feature, or nothing, pins nothing", () => {
    for (const resolved of [`ghcr.io/evil/z@sha256:${A}`, "ghcr.io/x/y:1", undefined])
      assert.throws(() => pinFeatures({ "ghcr.io/x/y:1": {} }, resolver({ features: { "ghcr.io/x/y:1": { resolved } } }).resolve),
        (err: Error) => err instanceof FeaturePinError && /could not be pinned/.test(err.message), String(resolved));
  });

  test("nothing declared: nothing resolved", () => {
    const { resolve, asked } = resolver({ features: {} });
    assert.deepEqual(pinFeatures({}, resolve), { features: {}, notes: [] });
    assert.equal(asked.length, 0);
  });
});

describe("what cannot be pinned is refused, before anything is resolved", () => {
  const never = () => assert.fail("the resolver was run for a feature that cannot be pinned");

  test("an https:// tarball", () => {
    assert.throws(() => pinFeatures({ "https://example.com/f.tgz": {} }, never),
      (err: Error) => err instanceof FeaturePinError && /tarball/.test(err.message) && /registry/.test(err.message));
  });

  test("a GitHub-releases id, a local path, a word", () => {
    for (const id of ["owner/repo/feature:1", "./features/mine", "feat", "localhost:5000/x/y:1"])
      assert.throws(() => pinFeatures({ [id]: {} }, never), (err: Error) => err instanceof FeaturePinError && /cannot pin|can pin/.test(err.message), id);
  });

  test("a feature that depends on others: named, with the dependency", () => {
    const { resolve } = resolver({ features: {
      "ghcr.io/x/parent:1": { resolved: `ghcr.io/x/parent@sha256:${A}`, dependsOn: ["ghcr.io/x/child:2"] },
      "ghcr.io/x/child:2": { resolved: `ghcr.io/x/child@sha256:${B}` },
    } });
    assert.throws(() => pinFeatures({ "ghcr.io/x/parent:1": {} }, resolve),
      (err: Error) => err instanceof FeaturePinError && /'ghcr.io\/x\/parent:1' depends on 'ghcr.io\/x\/child:2'/.test(err.message));
  });

  test("  and a dependency the resolver would install that the spec did not declare, however it got there", () => {
    const { resolve } = resolver({ features: {
      "ghcr.io/x/parent:1": { resolved: `ghcr.io/x/parent@sha256:${A}` },
      "ghcr.io/x/child:2": { resolved: `ghcr.io/x/child@sha256:${B}` },
    } });
    assert.throws(() => pinFeatures({ "ghcr.io/x/parent:1": {} }, resolve),
      (err: Error) => err instanceof FeaturePinError && /would install 'ghcr.io\/x\/child:2'/.test(err.message));
  });
});

describe("what must not reach up", () => {
  test("ids without a digest", () => {
    assert.deepEqual(unpinned({ [`ghcr.io/x/y@sha256:${A}`]: {}, "ghcr.io/x/z:1": {}, "https://e/f.tgz": {} }), ["ghcr.io/x/z:1", "https://e/f.tgz"]);
    assert.deepEqual(unpinned(undefined), []);
    assert.deepEqual(unpinned("features"), []);
  });
});
