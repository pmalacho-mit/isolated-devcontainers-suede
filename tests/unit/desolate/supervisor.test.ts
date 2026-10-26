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
  formatStatus,
  isRequest,
  memoryUsed,
  settingsFrom,
  specFor,
  targetOf,
} from "../../../release/vscode-image/supervisor.ts";

describe("what the supervisor accepts", () => {
  test("the five ops, in their exact shapes", () => {
    assert.ok(isRequest({ op: "status" }));
    for (const op of ["ensure", "stop", "reset", "purge"]) assert.ok(isRequest({ op, project: "acme/widgets" }), op);
  });

  for (const [why, query] of [
    ["an unknown op", { op: "run", project: "x" }],
    ["a project-taking op with no project", { op: "ensure" }],
    ["a reset that asks for more than a restart", { op: "reset", project: "x", data: true }],
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
    assert.deepEqual(json.builder, { gc: { enabled: true, defaultKeepStorage: "8GB" } });
  });

  test("its own daemon hands out addresses no VM bridge can have", () => {
    // Unpinned, the inner docker0 kept the subnet it chose at first start, and
    // a later `up` gave the dind's own VM network that same subnet: the VM
    // could no longer reach it (measured on the VM, 2026-10-26).
    const json = JSON.parse(specFor(targetOf("x"), settingsFrom({})).daemonJson);
    assert.equal(json.bip, "10.234.255.1/24");
    assert.deepEqual(json["default-address-pools"], [{ base: "10.234.0.0/17", size: 24 }]);
    assert.deepEqual(json["registry-mirrors"], ["http://127.0.0.1:5995"], "--shadow's mirror (#11)");
    // docker's default pools, which the VM's daemon draws every bridge from.
    for (const subnet of [json.bip, json["default-address-pools"][0].base])
      assert.ok(!/^(172\.(1[6-9]|2\d|3[01])|192\.168)\./.test(subnet), subnet);
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

describe("what `cli.sh dind list` prints", () => {
  const now = 10 * 60_000;
  const answer = {
    ok: true,
    dinds: [
      { name: "desolate-dind-acme__widgets", project: "acme/widgets", running: true, inUse: false,
        idleSince: now - 7 * 60_000, memory: 512 * 1024 ** 2, health: "healthy", imageStoreKib: 3 * 1024 ** 2 },
      { name: "desolate-dind-solo", project: "solo", running: true, inUse: true,
        idleSince: undefined, memory: undefined, health: "wedged", imageStoreKib: undefined },
      { name: "desolate-dind-old", project: "", running: false, inUse: false,
        idleSince: 0, memory: undefined, health: "stopped", imageStoreKib: 1024 },
    ],
    headroom: { running: 2, max: 16, available: 6 * 1024 ** 3, floor: 2 * 1024 ** 3 },
  };
  const [header, widgets, solo, old, , headroom] = formatStatus(answer, now).split("\n");

  test("one row per dind, under a header", () => {
    assert.match(header, /^PROJECT\s+STATE\s+IN USE\s+IDLE FOR\s+MEMORY\s+IMAGE STORE$/);
    assert.match(widgets, /^acme\/widgets\s+healthy\s+no\s+7 min\s+0\.5 GiB\s+3\.0 GiB$/);
  });

  test("a wedged dind says so, and what could not be measured is '?' rather than zero", () => {
    assert.match(solo, /^solo\s+wedged\s+yes\s+-\s+\?\s+\?$/);
  });

  test("a stopped dind keeps its image store, and a missing label falls back to the name", () => {
    assert.match(old, /^desolate-dind-old\s+stopped\s+-\s+-\s+-\s+0\.0 GiB$/);
  });

  test("the VM's headroom closes it", () => {
    assert.equal(headroom, "headroom: 2 of 16 dinds running; 6.0 GiB free, 2.0 GiB of it kept back");
  });

  test("no dinds is said, not left blank", () => {
    assert.match(formatStatus({ dinds: [], headroom: answer.headroom }, now), /^no project dinds\n/);
  });
});
