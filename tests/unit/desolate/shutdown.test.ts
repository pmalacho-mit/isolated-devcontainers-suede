/// <reference types="node" />
// The ORDER `desolate --stop` takes a devcontainer down in.
//
// The order is the whole content of shutdown.ts: stopping a container whose own
// daemon is mid-build leaves an init that never reports an exit, and a daemon
// waiting for that exit forever. Every step before the stop is best-effort, so
// the property that matters twice over is that the ordinary stop is REACHED --
// with a hung project, with a project that has no daemon at all, and with a
// quiesce step that returns nothing but failure.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { createDocker, type Runner } from "../../../release/vscode-image/docker.ts";
import * as shutdown from "../../../release/vscode-image/shutdown.ts";

const CID = "cid";

/** A docker whose every effect is recorded, and whose exit statuses are decided
 *  per invocation -- which is how "this project's daemon never answers" is
 *  spelled without a container to hang in. */
const recorder = (statusOf: (argv: string[]) => number = () => 0) => {
  const calls: string[][] = [];
  const said: string[] = [];
  const runner: Runner = {
    output: () => "",
    status: (argv) => {
      calls.push(argv);
      return statusOf(argv);
    },
    build: () => ({ ok: true, output: "" }),
  };
  const stop = () =>
    shutdown.devcontainer(createDocker(runner), CID, (message) =>
      said.push(message),
    );
  return { calls, said, stop };
};

const joined = (calls: string[][]) => calls.map((argv) => argv.join(" "));
const indexOfCall = (calls: string[][], fragment: string) =>
  joined(calls).findIndex((call) => call.includes(fragment));

/** The exec that a container which cannot answer would never complete. Both the
 *  guest's `timeout` and the exec's own bound report as a non-zero status. */
const isQuiesce = (argv: string[]) => argv.includes("timeout");
const HAS_DOCKER = "command -v docker";
const STOPPED_CONTAINERS = "docker stop --time";
const STOPPED_DAEMON = "pkill -TERM dockerd";

describe("stopping a devcontainer that has a daemon of its own", () => {
  test("quiesces before the container stop, never after", () => {
    const { calls, stop } = recorder();
    stop();

    const containers = indexOfCall(calls, STOPPED_CONTAINERS);
    const daemon = indexOfCall(calls, STOPPED_DAEMON);
    const stopped = indexOfCall(calls, "stop cid");

    assert.ok(containers >= 0, `no inner stop in ${joined(calls)}`);
    assert.ok(daemon >= 0, `no daemon stop in ${joined(calls)}`);
    assert.ok(stopped >= 0, `no container stop in ${joined(calls)}`);
    // Containers first, then the daemon that supervises them, then the
    // container holding both. Any other order stops something that is still
    // holding a mount namespace open.
    assert.ok(
      containers < daemon && daemon < stopped,
      `out of order: ${joined(calls)}`,
    );
  });

  test("the inner stop is bounded where it runs, not only where it is called", () => {
    // `timeout` kills a hung `docker stop` inside the container. An exec's own
    // bound merely stops WAITING for it, which leaves the work running.
    const { calls, stop } = recorder();
    stop();
    const inner = calls.find((argv) => argv.join(" ").includes(STOPPED_CONTAINERS))!;
    assert.equal(inner[inner.indexOf("timeout") + 2], "sh");
    assert.match(inner[inner.indexOf("timeout") + 1], /^\d+$/);
  });

  test("stopping nothing is not a failure", () => {
    // `docker stop` with no arguments is an error, and a project that happens
    // to be running no containers of its own must not be reported as hung.
    const { calls, stop } = recorder();
    stop();
    const inner = calls.find((argv) => argv.join(" ").includes(STOPPED_CONTAINERS))!;
    assert.match(inner.at(-1)!, /\[ -z "\$ids" \] \|\|/);
  });
});

describe("stopping a devcontainer that does not have one", () => {
  test("is the plain stop, with nothing asked of a daemon that is not there", () => {
    const { calls, said, stop } = recorder((argv) =>
      argv.join(" ").includes(HAS_DOCKER) ? 1 : 0,
    );
    stop();

    assert.equal(indexOfCall(calls, STOPPED_CONTAINERS), -1, `${joined(calls)}`);
    assert.equal(indexOfCall(calls, STOPPED_DAEMON), -1, `${joined(calls)}`);
    assert.ok(indexOfCall(calls, "stop cid") >= 0, `${joined(calls)}`);
    assert.deepEqual(said, []);
  });
});

describe("stopping a devcontainer whose daemon is already hung", () => {
  test("still reaches the ordinary stop, and says what it stepped over", () => {
    // The case the bounds exist for. A project that cannot be quiesced must
    // leave `--stop` exactly where it was before quiescing existed.
    const { calls, said, stop } = recorder((argv) => (isQuiesce(argv) ? 1 : 0));
    stop();

    assert.ok(indexOfCall(calls, "stop cid") >= 0, `${joined(calls)}`);
    assert.equal(said.filter((line) => line.startsWith("warning")).length, 2, `${said}`);
  });

  test("a probe that cannot be answered is a project with no daemon to quiesce", () => {
    // hasDockerCli is bounded too: a container that answers nothing at all
    // answers this the same way, and the stop proceeds either way.
    const { calls, stop } = recorder(() => 1);
    stop();
    assert.deepEqual(joined(calls).at(-1), "stop cid");
  });
});
