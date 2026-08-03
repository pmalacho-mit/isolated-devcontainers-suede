/// <reference types="node" />
// Host-port allocation.
//
// Getting this wrong is not a crash: it is a relay that silently binds a port
// another project is already serving on, or a URL that changes under a user
// between restarts. Both are invisible without a running stack, which is why
// the rule takes its view of the world as an argument.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  allocatePorts,
  ownRelayPorts,
  portMapFile,
  portRange,
  publishedPorts,
  PortRangeError,
  PortsExhaustedError,
  type PortWorld,
} from "../../../release/vscode-image/ports.ts";
// relays.ts has no `relay` export -- it exports name/hostPort/label/IMAGE
// individually, so the named import threw at module load and this whole file
// never ran. Namespace import, which is what every call site here assumes.
import * as relay from "../../../release/vscode-image/relays.ts";

/** Run `fn`, returning the error it threw. Fails the test if it did not throw. */
const thrown = (fn: () => unknown): Error => {
  try {
    fn();
  } catch (err) {
    return err as Error;
  }
  assert.fail("expected a throw");
};

const world = (over: Partial<PortWorld> = {}): PortWorld => ({
  range: { min: 8080, max: 8090 },
  published: new Map(),
  ownRelayPorts: new Set(),
  previous: new Map(),
  ...over,
});

describe("portRange", () => {
  test("defaults match the range dind publishes", () => {
    assert.deepEqual(portRange({}), { min: 8080, max: 8090 });
  });

  test("an empty string is absent, not zero", () => {
    // `DESOLATE_PORT_MIN=` in a .env is how a variable gets unset by accident.
    assert.deepEqual(portRange({ DESOLATE_PORT_MIN: "" }), { min: 8080, max: 8090 });
  });

  test("both bounds are read", () => {
    assert.deepEqual(
      portRange({ DESOLATE_PORT_MIN: "9000", DESOLATE_PORT_MAX: "9002" }),
      { min: 9000, max: 9002 },
    );
  });

  test("a bound that is not a port is refused", () => {
    for (const bad of ["0", "65536", "-1", "80.5", "eighty", "8080abc"])
      assert.throws(
        () => portRange({ DESOLATE_PORT_MIN: bad }),
        PortRangeError,
        `DESOLATE_PORT_MIN='${bad}' was accepted`,
      );
  });

  test("an inverted range is refused rather than yielding no ports", () => {
    assert.throws(
      () => portRange({ DESOLATE_PORT_MIN: "9000", DESOLATE_PORT_MAX: "8000" }),
      PortRangeError,
    );
  });

  test("a single-port range is legal", () => {
    assert.deepEqual(
      portRange({ DESOLATE_PORT_MIN: "8080", DESOLATE_PORT_MAX: "8080" }),
      { min: 8080, max: 8080 },
    );
  });
});

describe("allocatePorts", () => {
  test("every project gets an editor port, even with no app ports", () => {
    const map = allocatePorts(world(), []);
    assert.deepEqual([...map], [["editor", 8080]]);
  });

  test("app ports are keyed by the CONTAINER port, valued by the HOST port", () => {
    // The two are unrelated numbers and mixing them up produces a relay that
    // dials the wrong side. 5173 is the container's; 8081 is the Mac's.
    const map = allocatePorts(world(), [5173]);
    assert.deepEqual([...map], [["editor", 8080], ["5173", 8081]]);
  });

  test("a previous allocation is kept, so a bookmarked URL still works", () => {
    const previous = new Map([["editor", 8085], ["5173", 8083]]);
    const map = allocatePorts(world({ previous }), [5173]);
    assert.equal(map.get("editor"), 8085);
    assert.equal(map.get("5173"), 8083);
  });

  test("a remembered port that someone else took is replaced, not reused", () => {
    const map = allocatePorts(
      world({
        previous: new Map([["editor", 8085]]),
        published: new Map([[8085, "someone-elses-relay"]]),
      }),
      [],
    );
    assert.notEqual(map.get("editor"), 8085);
    assert.equal(map.get("editor"), 8080);
  });

  test("this project's OWN relay does not block reuse of its port", () => {
    // The relays are torn down and recreated moments later; treating them as a
    // clash would move every URL on every restart.
    const map = allocatePorts(
      world({
        previous: new Map([["editor", 8085]]),
        published: new Map([[8085, relay.name("myapp", 8085)]]),
        ownRelayPorts: new Set([8085]),
      }),
      [],
    );
    assert.equal(map.get("editor"), 8085);
  });

  test("ports in use by other containers are skipped", () => {
    const published = new Map([
      [8080, "other-a"],
      [8081, "other-b"],
      [8082, "other-c"],
    ]);
    assert.equal(allocatePorts(world({ published }), []).get("editor"), 8083);
  });

  test("no two labels get the same port within one allocation", () => {
    const map = allocatePorts(world(), [3000, 4000, 5000]);
    const assigned = [...map.values()];
    assert.equal(new Set(assigned).size, assigned.length, `collided: ${assigned}`);
  });

  test("a duplicated app port yields one entry and strands a host port", () => {
    // readProjectConfig dedupes before calling this. Pinning what happens if it
    // ever stops: the label is claimed twice, the second claim wins, and the
    // first port stays marked taken while nothing serves it.
    const map = allocatePorts(world(), [5173, 5173]);
    assert.equal(map.size, 2, "same label twice is still one entry");
    assert.equal(map.get("5173"), 8082, "the later claim overwrites the earlier");
  });

  test("exhaustion names who holds every port in the range", () => {
    const range = { min: 8080, max: 8082 };
    const published = new Map([
      [8080, "relay-for-alpha"],
      [8081, "relay-for-beta"],
    ]);
    const error = thrown(() =>
      allocatePorts(world({ range, published, ownRelayPorts: new Set([8082]) }), [1, 2]),
    );
    assert.ok(error instanceof PortsExhaustedError);

    // The whole point of the message: which project to stop.
    assert.match(error.message, /8080\s+relay-for-alpha/);
    assert.match(error.message, /8081\s+relay-for-beta/);
    assert.match(error.message, /8082\s+this project/);
    assert.match(error.message, /range 8080-8082 is full/);
    // and it must not claim every port belongs to this project
    assert.doesNotMatch(
      error.message,
      /8080\s+this project/,
      "a port held by another container was reported as ours",
    );
  });

  test("a port nobody publishes is reported as unknown, not as free", () => {
    // Reaching exhaustion with an unaccounted port means the range disagrees
    // with what dind publishes -- worth saying so rather than showing a blank.
    const range = { min: 8080, max: 8080 };
    const error = thrown(() =>
      allocatePorts(world({ range, published: new Map([[8080, "x"]]) }), [1]),
    );
    assert.ok(error instanceof PortsExhaustedError);
    assert.match(error.message, /8080\s+x/);
  });
});

describe("publishedPorts", () => {
  test("reads the host port out of a docker ps ports column", () => {
    const out = [
      "relay-a\t0.0.0.0:8080->8080/tcp",
      "relay-b\t0.0.0.0:8081->8081/tcp, :::8081->8081/tcp",
      "idle-c\t",
    ].join("\n");
    assert.deepEqual(
      [...publishedPorts(out)],
      [
        [8080, "relay-a"],
        [8081, "relay-b"],
      ],
    );
  });

  test("a container with no published ports contributes nothing", () => {
    assert.equal(publishedPorts("lonely\t").size, 0);
    assert.equal(publishedPorts("").size, 0);
  });

  test("the CONTAINER side of the mapping is never mistaken for the host side", () => {
    // "0.0.0.0:8080->5173/tcp" publishes 8080. Matching 5173 here would let a
    // second project bind 8080 believing it free.
    const published = publishedPorts("relay\t0.0.0.0:8080->5173/tcp");
    assert.deepEqual([...published.keys()], [8080]);
  });
});

describe("relay names carry the host port back", () => {
  test("compose and decompose agree", () => {
    for (const project of ["myapp", "owner/repo"])
      for (const port of [8080, 65535])
        assert.equal(relay.hostPort(relay.name(project, port)), port);
  });

  test("a nested project's slash does not break the port suffix", () => {
    assert.equal(relay.name("owner/repo", 8080), "desolate-relay-owner__repo-8080");
    assert.equal(relay.hostPort("desolate-relay-owner__repo-8080"), 8080);
  });

  test("a name with no trailing port yields undefined, not NaN", () => {
    // Number("") is 0 and Number("repo") is NaN; either one entering the
    // own-ports set would corrupt the availability test.
    for (const name of ["desolate-relay-myapp", "desolate-relay-myapp-", "some-other-container"])
      assert.equal(relay.hostPort(name), undefined, name);
  });

  test("ownRelayPorts drops anything unparseable", () => {
    const ports = ownRelayPorts([
      relay.name("myapp", 8080),
      "desolate-relay-myapp",
      relay.name("myapp", 8081),
    ]);
    assert.deepEqual([...ports].sort(), [8080, 8081]);
  });
});

describe("the port map file", () => {
  test("round-trips", () => {
    const map = new Map([["editor", 8080], ["5173", 8081]]);
    assert.deepEqual([...portMapFile.parse(portMapFile.format(map))], [...map]);
  });

  test("tolerates a truncated or hand-edited file", () => {
    const parsed = portMapFile.parse("editor 8080\ngarbage\n\n  5173   8081  \n");
    assert.deepEqual([...parsed], [["editor", 8080], ["5173", 8081]]);
  });

  test("a non-numeric port is dropped rather than becoming NaN", () => {
    assert.deepEqual([...portMapFile.parse("editor eighty")], []);
  });
});
