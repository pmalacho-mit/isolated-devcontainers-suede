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
  ingressPorts,
  movePort,
  ownRelayPorts,
  portBase,
  portMapFile,
  publishedPorts,
  PortRangeError,
  PortsExhaustedError,
  type PortWorld,
} from "../../../release/vscode-image/ports.ts";
import * as relay from "../../../release/vscode-image/relays.ts";
import { target } from "../../../release/vscode-image/projects.ts";

/** The target a name denotes, in the default workspace. */
const named = (project: string) => target("/workspaces", project);

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
  base: 8080,
  published: new Map(),
  ownRelayPorts: new Set(),
  previous: new Map(),
  ...over,
});

describe("portBase", () => {
  test("defaults to 8080, where the range used to start", () => {
    assert.equal(portBase({}), 8080);
  });

  test("an empty string is absent, not zero", () => {
    // `DESOLATE_PORT_BASE=` in a .env is how a variable gets unset by accident.
    assert.equal(portBase({ DESOLATE_PORT_BASE: "" }), 8080);
  });

  test("it is read", () => {
    assert.equal(portBase({ DESOLATE_PORT_BASE: "9000" }), 9000);
  });

  test("below 1024 is refused: Lima forwards those onto the Mac's LAN", () => {
    for (const bad of ["80", "443", "1023"])
      assert.throws(() => portBase({ DESOLATE_PORT_BASE: bad }), /onto the Mac's LAN/, bad);
  });

  test("a base that is not a port is refused", () => {
    for (const bad of ["0", "65536", "-1", "80.5", "eighty", "8080abc"])
      assert.throws(() => portBase({ DESOLATE_PORT_BASE: bad }), PortRangeError, bad);
  });
});

describe("what the ingress is already serving", () => {
  test("each ports/ file is a held port, holding what it forwards to", () => {
    const held = ingressPorts(new Map([
      ["8080", "desolate-dind:8080\n"],
      ["8081", "desolate-dind-acme__widgets:5173\n"],
    ]));
    assert.deepEqual([...held], [[8080, "desolate-dind:8080"], [8081, "desolate-dind-acme__widgets:5173"]]);
  });

  test("files the ingress would ignore hold nothing", () => {
    // The writers' temporary files, and anything not named as a port.
    const held = ingressPorts(new Map([[".8080", "x"], ["8080.tmp", "x"], ["08080", "x"], ["README", "x"]]));
    assert.equal(held.size, 0);
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
    assert.deepEqual(
      [...map],
      [
        ["editor", 8080],
        ["5173", 8081],
      ],
    );
  });

  test("a previous allocation is kept, so a bookmarked URL still works", () => {
    const previous = new Map([
      ["editor", 8085],
      ["5173", 8083],
    ]);
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
        published: new Map([[8085, relay.name(named("myapp"), 8085)]]),
        ownRelayPorts: new Set([8085]),
      }),
      [],
    );
    assert.equal(map.get("editor"), 8085);
  });

  test("two worktrees of one project each keep their own stable port", () => {
    // They allocate independently, from saved maps of their own, so the only
    // thing stopping them fighting over one port is that each sees the other's
    // relay as published -- and recognises only ITS OWN as reusable.
    const project = target("/workspaces", "acme/widgets");
    const feature = target("/workspaces", "acme/widgets", "feature123");
    const other = target("/workspaces", "acme/widgets", "other");

    const running = new Map([
      [8080, relay.name(project, 8080)],
      [8081, relay.name(feature, 8081)],
      [8082, relay.name(other, 8082)],
    ]);

    for (const [held, target] of [
      [8081, feature],
      [8082, other],
    ] as const) {
      const map = allocatePorts(
        world({
          published: running,
          previous: new Map([["editor", held]]),
          ownRelayPorts: ownRelayPorts([relay.name(target, held)]),
        }),
        [],
      );
      assert.equal(map.get("editor"), held, target.name);
    }
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
    assert.equal(
      new Set(assigned).size,
      assigned.length,
      `collided: ${assigned}`,
    );
  });

  test("a duplicated app port yields one entry and strands a host port", () => {
    // readProjectConfig dedupes before calling this. Pinning what happens if it
    // ever stops: the label is claimed twice, the second claim wins, and the
    // first port stays marked taken while nothing serves it.
    const map = allocatePorts(world(), [5173, 5173]);
    assert.equal(map.size, 2, "same label twice is still one entry");
    assert.equal(
      map.get("5173"),
      8082,
      "the later claim overwrites the earlier",
    );
  });

  test("there is no ceiling short of 65535: past a held block, the next one", () => {
    const published = new Map(Array.from({ length: 200 }, (_, i) => [8080 + i, `relay-${i}`] as [number, string]));
    assert.equal(allocatePorts(world({ published }), []).get("editor"), 8280);
  });

  test("exhaustion names who holds the ports, lowest first", () => {
    const published = new Map(
      Array.from({ length: 65535 - 65530 + 1 }, (_, i) => [65530 + i, `relay-${i}`] as [number, string]),
    );
    const error = thrown(() =>
      allocatePorts(world({ base: 65530, published, ownRelayPorts: new Set([65535]) }), [1, 2]),
    );
    assert.ok(error instanceof PortsExhaustedError);
    assert.match(error.message, /65530\s+relay-0/);
    assert.match(error.message, /65535\s+this project/);
    assert.doesNotMatch(error.message, /65530\s+this project/, "a port held by another was reported as ours");
  });
});

describe("moving one label (desolate --ports --move)", () => {
  // For when the Mac already holds a port: Lima never forwards it, and never
  // retries (vm-loopback-forward.sh L6), so the only fix is a different port.
  const previous = new Map([["editor", 8080], ["5173", 8081]]);

  test("moves exactly the one label", () => {
    assert.deepEqual([...movePort(world({ previous }), "5173", 9000)], [["editor", 8080], ["5173", 9000]]);
  });

  test("refuses an unknown label, saying what there is", () => {
    assert.throws(() => movePort(world({ previous }), "3000", 9000), /no port is allocated to '3000' \(have: editor, 5173\)/);
  });

  test("refuses a port somebody else holds, naming them", () => {
    assert.throws(
      () => movePort(world({ previous, published: new Map([[9000, "desolate-dind:9000"]]) }), "5173", 9000),
      /9000 is held by desolate-dind:9000/,
    );
  });

  test("refuses one of this target's own other labels", () => {
    assert.throws(() => movePort(world({ previous }), "5173", 8080), /already this target's 'editor'/);
  });

  test("refuses a port the ingress would not forward", () => {
    for (const port of [80, 1023, 65536, 8080.5])
      assert.throws(() => movePort(world({ previous }), "5173", port), PortRangeError, String(port));
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
        assert.equal(relay.hostPort(relay.name(named(project), port)), port);
  });

  test("a nested project's slash does not break the port suffix", () => {
    assert.equal(
      relay.name(named("owner/repo"), 8080),
      "desolate-relay-owner__repo-8080",
    );
    assert.equal(relay.hostPort("desolate-relay-owner__repo-8080"), 8080);
  });

  test("a name with no trailing port yields undefined, not NaN", () => {
    // Number("") is 0 and Number("repo") is NaN; either one entering the
    // own-ports set would corrupt the availability test.
    for (const name of [
      "desolate-relay-myapp",
      "desolate-relay-myapp-",
      "some-other-container",
    ])
      assert.equal(relay.hostPort(name), undefined, name);
  });

  test("ownRelayPorts drops anything unparseable", () => {
    const ports = ownRelayPorts([
      relay.name(named("myapp"), 8080),
      "desolate-relay-myapp",
      relay.name(named("myapp"), 8081),
    ]);
    assert.deepEqual([...ports].sort(), [8080, 8081]);
  });
});

describe("the port map file", () => {
  test("round-trips", () => {
    const map = new Map([
      ["editor", 8080],
      ["5173", 8081],
    ]);
    assert.deepEqual([...portMapFile.parse(portMapFile.format(map))], [...map]);
  });

  test("tolerates a truncated or hand-edited file", () => {
    const parsed = portMapFile.parse(
      "editor 8080\ngarbage\n\n  5173   8081  \n",
    );
    assert.deepEqual(
      [...parsed],
      [
        ["editor", 8080],
        ["5173", 8081],
      ],
    );
  });

  test("a non-numeric port is dropped rather than becoming NaN", () => {
    assert.deepEqual([...portMapFile.parse("editor eighty")], []);
  });
});
