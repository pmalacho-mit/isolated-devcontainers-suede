/// <reference types="node" />
// The host each surface is reached at (hosts.ts): one per target, one for the
// outer editor, never 127.0.0.1 -- a cookie is scoped by host, not by port.
// The ingress computes the same names (ingress.py expected_host); both are
// held to tests/unit/fixtures/hosts.json.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { EDITOR_HOST, hostOf, originOf } from "../../../release/vscode-image/hosts.ts";

const FIXTURE: Record<string, string> = JSON.parse(readFileSync(new URL("../fixtures/hosts.json", import.meta.url), "utf8"));

describe("a target's host", () => {
  test("is the one the ingress expects, name for name", () => {
    for (const [name, host] of Object.entries(FIXTURE)) assert.equal(hostOf(name), host, name);
  });

  test("is one DNS label under .localhost: no name can make it a subdomain of another's", () => {
    for (const name of [...Object.keys(FIXTURE), "acme__my.app", "a.b.c"]) {
      const host = hostOf(name);
      assert.match(host, /^[a-z0-9]([a-z0-9-]*[a-z0-9])?\.localhost$/, host);
      assert.ok(host.split(".")[0].length <= 63, host);
    }
  });

  test("differs for names that read alike: the hex is of the namespace, exactly", () => {
    const alike = ["acme__widgets", "Acme__Widgets", "acme__widgets-", "acme--widgets", "acme_widgets"];
    assert.equal(new Set(alike.map(hostOf)).size, alike.length);
  });

  test("is never the outer editor's, nor 127.0.0.1", () => {
    for (const name of [...Object.keys(FIXTURE), "desolate", "localhost"]) {
      assert.notEqual(hostOf(name), EDITOR_HOST);
      assert.notEqual(hostOf(name), "localhost");
    }
    assert.equal(EDITOR_HOST, "desolate.localhost");
  });

  test("its origin carries the port", () => {
    assert.equal(originOf("acme__widgets", 8081), `http://${FIXTURE["acme__widgets"]}:8081`);
  });
});
