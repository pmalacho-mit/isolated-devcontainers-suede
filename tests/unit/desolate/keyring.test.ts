// The keyring's path layout, which is where a private-key disclosure lived.
//
// The bug these tests pin: keys were stored as `deploy_<alias>` beside
// `deploy_<alias>.pub`, and the listing parsed aliases back out with
// /^deploy_(.+)\.pub$/. An alias of "a.pub" therefore put a PRIVATE key at a
// path ending in .pub, the listing invented a phantom alias "a", and asking for
// "a"'s public key returned that private key -- and copied it into the
// world-readable directory the editor mounts. Both requests are ones a
// compromised editor can make over the control socket.
//
// The fix is structural (one directory per alias, fixed filenames inside), so
// these tests assert the structure rather than the specific spelling that
// triggered it. A future layout that reintroduces filename parsing should fail
// here.
import { test, describe } from "node:test";
import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  keyPath,
  pubPath,
  listAliases,
  validAlias,
} from "../../../release/vscode-image/keyring.ts";

describe("keyring alias validation", () => {
  test("accepts the aliases newrepo actually generates", () => {
    for (const alias of ["acme__widgets", "a", "my-repo", "repo.js", "a1_b2"])
      assert.ok(validAlias(alias), `${alias} should be accepted`);
  });

  test("refuses anything that could leave the keys directory", () => {
    for (const alias of [
      "../etc",
      "a/../../b",
      "a/b",
      ".hidden",
      "-flag",
      "",
      "..",
    ])
      assert.ok(!validAlias(alias), `${alias} must be refused`);
  });

  test("refuses non-strings from the control socket", () => {
    for (const alias of [null, undefined, 42, {}, ["a"], true])
      assert.ok(!validAlias(alias), `${JSON.stringify(alias)} must be refused`);
  });
});

describe("keyring path layout", () => {
  test("a private key path never ends in .pub, whatever the alias", () => {
    // The disclosure precondition. If this can be made false, an alias exists
    // whose PRIVATE key masquerades as a public one.
    for (const alias of ["a.pub", "id.pub", "x.pub.pub", "acme__widgets"]) {
      if (!validAlias(alias)) continue;
      assert.ok(
        !keyPath(alias).endsWith(".pub"),
        `private key for '${alias}' is at ${keyPath(alias)}, which ends in .pub`,
      );
    }
  });

  test("two different aliases never share a path", () => {
    // "a.pub" and "a" collided under the old scheme: deploy_a.pub was both the
    // private key of the first and the public key of the second.
    const aliases = ["a", "a.pub", "a.pub.pub", "b"];
    const paths = aliases.flatMap((a) => [keyPath(a), `${keyPath(a)}.pub`]);
    assert.equal(
      new Set(paths).size,
      paths.length,
      `path collision among ${aliases.join(", ")}: ${paths.join(" ")}`,
    );
  });

  test("the exported public path is distinct from any private path", () => {
    for (const alias of ["a", "a.pub", "acme__widgets"])
      assert.notEqual(pubPath(alias), keyPath(alias));
  });
});

describe("keyring listing", () => {
  const withKeys = (layout: Record<string, string[]>, run: (dir: string) => void) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keyring-"));
    try {
      for (const [alias, files] of Object.entries(layout)) {
        fs.mkdirSync(path.join(dir, alias), { recursive: true });
        for (const f of files) fs.writeFileSync(path.join(dir, alias, f), "x");
      }
      run(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };

  test("lists exactly the aliases that have a public half", () => {
    withKeys(
      { alpha: ["id", "id.pub"], beta: ["id", "id.pub"], halfmade: ["id"] },
      (dir) => assert.deepEqual(listAliases(dir), ["alpha", "beta"]),
    );
  });

  test("invents no alias from a file name, however it is spelled", () => {
    // Under the old scheme this directory produced a phantom alias.
    withKeys({ "a.pub": ["id", "id.pub"] }, (dir) => {
      assert.deepEqual(listAliases(dir), ["a.pub"]);
      assert.ok(!listAliases(dir).includes("a"), "phantom alias 'a' reappeared");
    });
  });

  test("an empty or missing keys directory lists nothing", () => {
    withKeys({}, (dir) => assert.deepEqual(listAliases(dir), []));
    assert.deepEqual(listAliases("/nonexistent/keyring"), []);
  });
});
