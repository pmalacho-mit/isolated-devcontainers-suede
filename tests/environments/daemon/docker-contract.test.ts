/// <reference types="node" />
// The docker CLI's opinion of the argv docker.ts builds.
//
// tests/unit/desolate/docker.test.ts pins what we MEANT to send. Nothing there
// can tell you the daemon accepts it: `--opt` keys, mount-spec grammar and
// template syntax are all validated by a program this repo does not control,
// and every one of them has produced a runtime-only failure before.
//
// Runs only inside tests/environments/daemon, which is the only environment
// given a socket.

import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";

import { createDocker, type Runner } from "../../../release/vscode-image/docker.ts";
import { overlayOptions } from "../../../release/vscode-image/overlay.ts";

/** The real thing: the same two shapes the production runner has. */
const realRunner: Runner = {
  output: (argv) => {
    try {
      return execFileSync("docker", argv, { encoding: "utf8" }).trim();
    } catch {
      return "";
    }
  },
  // Captured, never inherited. A child writing straight to this process's fd 1
  // interleaves with the test reporter's own output and truncates it.
  status: (argv) => {
    try {
      execFileSync("docker", argv, { stdio: ["ignore", "pipe", "pipe"] });
      return 0;
    } catch (err: any) {
      return err?.status ?? 1;
    }
  },
};

const docker = createDocker(realRunner);
const HELPER = "alpine:3";
const tag = `desolate-test-${randomBytes(4).toString("hex")}`;
const rubbish: { volumes: string[]; containers: string[] } = {
  volumes: [],
  containers: [],
};

after(() => {
  docker.container.remove(rubbish.containers);
  docker.volume.remove(rubbish.volumes);
});

const volume = (suffix: string) => {
  const name = `${tag}-${suffix}`;
  rubbish.volumes.push(name);
  return name;
};

/** A directory ON THE DAEMON'S filesystem, holding one known file.
 *
 *  `lowerdir` is resolved by the daemon, not by this process, so a host path
 *  that happens to exist here says nothing about what the daemon can see. A
 *  volume's mountpoint is a path the daemon owns by definition -- and it is the
 *  same shape production uses, where the lower is a directory dind holds. */
const lowerWith = (suffix: string, filename: string, contents: string) => {
  const name = volume(suffix);
  docker.volume.create(name);
  assert.equal(
    docker.inVolume(HELPER, name, "/d", [
      "sh", "-c", `printf '%s' '${contents}' > /d/${filename}`,
    ]),
    0,
    `could not seed the lower '${name}'`,
  );
  const mountpoint = docker.volume.mountpoint(name);
  assert.ok(mountpoint, `no mountpoint for the lower '${name}'`);
  return { path: mountpoint, volume: name };
};

/** An overlay view of `lower`, prepared exactly as ensureVolume prepares one. */
const viewOf = (suffix: string, lower: string) => {
  const data = volume(`${suffix}-data`);
  docker.volume.create(data);
  assert.equal(
    docker.inVolume(HELPER, data, "/d", ["sh", "-c", "mkdir -p /d/upper /d/work"]),
    0,
    "helper could not prepare upper/work",
  );
  const mountpoint = docker.volume.mountpoint(data);
  assert.ok(mountpoint, "no mountpoint for the data volume");
  const view = volume(`${suffix}-view`);
  const options = overlayOptions(lower, mountpoint);
  assert.equal(
    docker.volume.createOverlay(view, options, {}),
    0,
    `the daemon refused the overlay options (${options})`,
  );
  return view;
};

describe("the daemon accepts what docker.ts builds", () => {
  test("a plain volume with labels", () => {
    const name = volume("plain");
    assert.equal(docker.volume.create(name, { "desolate.overlay.of": "x" }), 0);
    assert.equal(docker.volume.label(name, "desolate.overlay.of"), "x");
  });

  test("a label lookup for a label that is absent yields empty, not an error", () => {
    // ensureVolume compares this against the wanted key; a thrown error or the
    // string "<no value>" would both be read as "cached and current".
    const name = volume("nolabel");
    docker.volume.create(name);
    assert.equal(docker.volume.label(name, "desolate.overlay.key"), "");
  });

  test("mountpoint comes back as an absolute path", () => {
    const name = volume("mp");
    docker.volume.create(name);
    assert.match(docker.volume.mountpoint(name), /^\//);
  });

  test("the overlay --opt keys are the ones the local driver takes", () => {
    // `type=overlay`, `device=overlay` and a single `o=` are what the local
    // driver accepts; anything else is refused at CREATE time, which is the
    // failure this whole environment exists to surface.
    const lower = lowerWith("opt-lower", "marker", "x");
    const data = volume("data");
    docker.volume.create(data);
    assert.equal(
      docker.inVolume(HELPER, data, "/d", ["sh", "-c", "mkdir -p /d/upper /d/work"]),
      0,
      "helper could not prepare upper/work",
    );

    const mountpoint = docker.volume.mountpoint(data);
    assert.ok(mountpoint, "no mountpoint for the data volume");

    const view = volume("view");
    const options = overlayOptions(lower.path, mountpoint);
    assert.equal(
      docker.volume.createOverlay(view, options, { "desolate.overlay.key": "abc123" }),
      0,
      `the daemon refused the overlay options (${options})`,
    );

    // Stored verbatim: `intact` compares the string it reads back against a
    // freshly built one, so any normalisation by the daemon breaks the cache.
    assert.equal(docker.volume.options(view), options);
    assert.equal(docker.volume.label(view, "desolate.overlay.key"), "abc123");
  });

  test("an overlay volume actually mounts, and the lower shows through", () => {
    // `docker volume create` is LAZY -- it succeeds without mounting anything,
    // so the only proof is a container that mounts it.
    const lower = lowerWith("m-lower", "marker", "from-the-lower");
    const view = viewOf("m", lower.path);

    assert.equal(
      docker.inVolume(HELPER, view, "/mnt", ["test", "-e", "/mnt/marker"]),
      0,
      "the overlay mounted but the lower's contents are not visible",
    );
  });

  test("a write through the view does not reach the lower", () => {
    // The entire reason for the design: a project writing into its view must
    // not be able to change what every other project reads.
    const lower = lowerWith("cow-lower", "marker", "from-the-lower");
    const view = viewOf("cow", lower.path);

    assert.equal(
      docker.inVolume(HELPER, view, "/mnt", [
        "sh", "-c", "echo poisoned > /mnt/marker",
      ]),
      0,
      "could not write into the view",
    );
    // The view sees its own write ...
    assert.equal(
      docker.inVolume(HELPER, view, "/mnt", ["grep", "-q", "poisoned", "/mnt/marker"]),
      0,
      "the write did not land in the view",
    );
    // ... and the lower, read through its own volume, is untouched.
    assert.equal(
      docker.inVolume(HELPER, lower.volume, "/lower", [
        "grep", "-q", "from-the-lower", "/lower/marker",
      ]),
      0,
      "the write reached the shared lower",
    );
  });

  test("deleting a project's view leaves the lower intact", () => {
    // cleanup() removes both volumes before every rebuild; doing so must not
    // take the shared original with it.
    const lower = lowerWith("del-lower", "marker", "from-the-lower");
    const view = viewOf("del", lower.path);
    assert.equal(docker.volume.remove([view, `${tag}-del-data`]), 0);
    assert.equal(
      docker.inVolume(HELPER, lower.volume, "/lower", ["test", "-e", "/lower/marker"]),
      0,
      "removing the view destroyed the lower",
    );
  });

  test("removing volumes that do not exist is not an error", () => {
    // cleanup() runs before every rebuild, including the first.
    assert.equal(docker.volume.remove([`${tag}-never-created`]), 0);
  });
});

describe("container queries against a real container", () => {
  const name = `${tag}-probe`;

  test("state, networks and label filtering agree with the daemon", () => {
    execFileSync("docker", [
      "run", "-d", "--name", name,
      "--label", "desolate.relay=probe-project",
      HELPER, "sleep", "60",
    ], { stdio: ["ignore", "pipe", "pipe"] });
    rubbish.containers.push(name);

    assert.equal(docker.container.state(name), "running");

    assert.deepEqual(docker.container.namesWithLabel("desolate.relay=probe-project"), [name]);
    assert.deepEqual(docker.container.namesWithLabel("desolate.relay=nobody"), []);

    // The pair template must yield one (network, ip) per line, with a real
    // address -- not two concatenated fields.
    const networks = docker.container.networks(name);
    assert.ok(networks.length >= 1, "no networks reported");
    for (const { network, ip } of networks) {
      assert.doesNotMatch(network, /\s/, `'${network}' looks concatenated`);
      if (ip) assert.match(ip, /^[0-9.]+$/);
    }
  });

  test("the published-ports table parses back to the port we published", async () => {
    const { publishedPorts } = await import("../../../release/vscode-image/ports.ts");
    const published = `${tag}-pub`;
    execFileSync("docker", [
      "run", "-d", "--name", published, "-p", "127.0.0.1:0:80", HELPER, "sleep", "60",
    ], { stdio: ["ignore", "pipe", "pipe"] });
    rubbish.containers.push(published);

    const table = docker.container.publishedPortsTable();
    const ports = publishedPorts(table);
    const mine = [...ports].filter(([, container]) => container === published);
    assert.equal(mine.length, 1, `expected one published port, table was:\n${table}`);
    // The HOST side, not the container's 80.
    assert.notEqual(mine[0][0], 80);
  });

  test("state of a container that does not exist is empty, not a throw", () => {
    // recreateRelays polls this in a loop; a throw there would abort the start
    // instead of retrying.
    assert.equal(docker.container.state(`${tag}-absent`), "");
  });
});
