/// <reference types="node" />
// The supervisor's narrow surface: what it accepts, and what it builds.
//
// It holds the VM's docker socket, so the request guard is the boundary: a
// compromised orchestrator speaking to it must be able to name a project and
// nothing else -- no flag, no path, no second field that some later code
// might read.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  cpusFor,
  isRequest,
  memoryUsed,
  settingsFrom,
  specFor,
  targetOf,
} from "../../../release/vscode-image/supervisor.ts";

describe("what the supervisor accepts", () => {
  test("the four ops, in their exact shapes", () => {
    assert.ok(isRequest({ op: "status" }));
    for (const op of ["ensure", "stop", "purge"]) assert.ok(isRequest({ op, project: "acme/widgets" }), op);
  });

  for (const [why, query] of [
    ["an unknown op", { op: "run", project: "x" }],
    ["a project-taking op with no project", { op: "ensure" }],
    ["a project that is not a string", { op: "ensure", project: ["x"] }],
    ["status with a project", { op: "status", project: "x" }],
    ["an extra field a later reader might honour", { op: "ensure", project: "x", runtime: "runc" }],
    ["a docker flag", { op: "ensure", project: "x", args: ["--privileged"] }],
    ["null", null],
    ["a string", "ensure x"],
  ] as const)
    test(`refuses ${why}`, () => assert.equal(isRequest(query), false));

  test("project names are held to the same rules as everywhere else", () => {
    assert.equal(targetOf("acme/widgets").project, "acme/widgets");
    for (const bad of ["../etc", "a/b/c", ".hidden", "", "a__b", "a--wt--b"])
      assert.throws(() => targetOf(bad), bad);
  });
});

describe("what the supervisor builds", () => {
  test("sysbox by default; runc only when the nested harness asks twice", () => {
    assert.equal(settingsFrom({}).runtime, "sysbox-runc");
    assert.throws(() => settingsFrom({ DESOLATE_DIND_RUNTIME: "runc" }), /refused outside the nested test harness/);
    assert.equal(
      settingsFrom({ DESOLATE_DIND_RUNTIME: "runc", DESOLATE_NESTED_HARNESS: "1" }).runtime,
      "runc",
    );
    assert.throws(() => settingsFrom({ DESOLATE_DIND_RUNTIME: "kata" }), /must be sysbox-runc or runc/);
  });

  test("a malformed idle period is a refusal, not a reaper that never or always fires", () => {
    for (const raw of ["0", "-5", "soon"])
      assert.throws(() => settingsFrom({ DESOLATE_DIND_IDLE: raw }), /positive number/, raw);
    assert.equal(settingsFrom({}).idleMs, 30 * 60_000);
  });

  test("the spec names the compose volumes, and this project as its subpath", () => {
    const spec = specFor(targetOf("acme/widgets"), settingsFrom({}));
    assert.equal(spec.name, "desolate-dind-acme__widgets");
    assert.equal(spec.project, "acme/widgets");
    assert.deepEqual(spec.volumes, {
      data: "dind-data-acme__widgets",
      workspaces: "desolate_workspaces",
      sockets: "desolate_dind-sockets",
      socketSubpath: "acme__widgets",
      serverDist: "desolate_server-dist",
      health: "desolate_inner-health",
    });
    assert.match(spec.network, /^br-d-[0-9a-f]{10}$/);
  });

  test("the BuildKit GC policy is in daemon.json, and the env sizes it", () => {
    const json = JSON.parse(specFor(targetOf("x"), settingsFrom({ DESOLATE_DIND_BUILD_CACHE: "8GB" })).daemonJson);
    assert.deepEqual(json, { builder: { gc: { enabled: true, defaultKeepStorage: "8GB" } } });
  });

  test("the cpu cap is never more than the machine has, which docker would refuse", () => {
    assert.equal(cpusFor("4", 8), "4");
    assert.equal(cpusFor("4", 2), "2");
    assert.equal(cpusFor("1.5", 2), "1.5");
    assert.equal(cpusFor("4", 0), "4", "a machine that will not say is not clamped to zero");
    assert.throws(() => cpusFor("all", 8), /positive number/);
  });

  test("docker stats memory parses in both unit systems", () => {
    assert.equal(memoryUsed("490.2MiB / 15.6GiB"), Math.round(490.2 * 1024 ** 2));
    assert.equal(memoryUsed("1.5GiB / 16GiB"), 1.5 * 1024 ** 3);
    assert.equal(memoryUsed("12kB / 1GB"), 12_000);
    assert.equal(memoryUsed("-- / --"), undefined);
    assert.equal(memoryUsed(""), undefined);
  });
});
