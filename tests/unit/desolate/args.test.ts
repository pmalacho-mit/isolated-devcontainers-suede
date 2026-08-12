/// <reference types="node" />
// The desolate command line.
//
// The broker spawns desolate with flags it builds itself, so this grammar is a
// contract between two files rather than a convenience for humans. Every shape
// broker.ts can emit is exercised here.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  parseArgs,
  UsageError,
  type Flags,
} from "../../../release/vscode-image/args.ts";

const parse = (...argv: string[]) => parseArgs(argv);
const refuses = (argv: string[], match: RegExp) =>
  assert.throws(() => parseArgs(argv), (err: Error) => {
    assert.ok(err instanceof UsageError, `expected UsageError, got ${err.name}`);
    assert.match(err.message, match);
    return true;
  });

describe("parseArgs", () => {
  test("a bare project name runs it", () => {
    assert.deepEqual(parse("myapp"), {
      command: "run",
      project: "myapp",
      worktree: undefined,
      config: undefined,
      rebuild: false,
      noCache: false,
      all: false,
    });
  });

  test("a project may be nested one level", () => {
    assert.equal(parse("owner/repo").project, "owner/repo");
  });

  test("the absolute path tab-completion produces means the same project", () => {
    // `desolate /workspaces/myapp/` is what completing a directory gives you.
    assert.equal(parse("/workspaces/myapp").project, "myapp");
    assert.equal(parse("/workspaces/myapp/").project, "myapp");
    assert.equal(parse("/workspaces/owner/repo//").project, "owner/repo");
    // ... but only as a PREFIX. A project that merely contains the word stays put.
    assert.equal(parse("my-workspaces-thing").project, "my-workspaces-thing");
  });

  test("flags are order-independent", () => {
    const before = parse("--rebuild", "--config", "/snap/dc.json", "myapp");
    const after = parse("myapp", "--config", "/snap/dc.json", "--rebuild");
    assert.deepEqual(before, after);
    assert.equal(before.config, "/snap/dc.json");
    assert.equal(before.rebuild, true);
  });

  test("--no-cache implies --rebuild", () => {
    // A fresh image with a reused container would be a no-op that looks like it
    // worked, so the two cannot be requested separately.
    const args = parse("--no-cache", "myapp");
    assert.equal(args.noCache, true);
    assert.equal(args.rebuild, true);
  });

  test("--stop and --ports select a subcommand", () => {
    assert.equal(parse("--stop", "myapp").command, "stop");
    assert.equal(parse("--ports", "myapp").command, "ports");
    assert.equal(parse("myapp").command, "run");
  });

  test("an unknown option is refused, never ignored", () => {
    // Silently dropping a flag is how a caller believes it asked for something
    // it did not get -- the broker builds these programmatically.
    refuses(["--nope", "myapp"], /unknown option '--nope'/);
    refuses(["--rebuild=true", "myapp"], /unknown option/);
  });

  test("exactly one project is required", () => {
    refuses([], /usage:/);
    refuses(["--rebuild"], /usage:/);
    refuses(["a", "b"], /received 2/);
  });
});

describe("the commands that act on every target", () => {
  test("--list names no target, and so has no project slot", () => {
    const args = parse("--list");
    assert.equal(args.command, "list");
    assert.equal(args.project, undefined);
  });

  test("--stop --all is stop, widened", () => {
    const args = parse("--stop", "--all");
    assert.equal(args.command, "stop");
    assert.equal(args.all, true);
    assert.equal(args.project, undefined);
  });

  test("a project given to either is refused, not ignored", () => {
    // Ignoring it would act on EVERY target while naming one, which is the
    // difference between stopping a project and stopping the stack.
    refuses(["--list", "myapp"], /takes no project/);
    refuses(["--stop", "--all", "myapp"], /takes no project/);
  });

  test("--all is meaningless without --stop, and says so", () => {
    // There is no --list --all or --rebuild --all to fall back to, so a silent
    // ignore would leave the user believing they had asked for something.
    refuses(["--all", "myapp"], /--all only means something with --stop/);
    refuses(["--rebuild", "--all", "myapp"], /--all only means something/);
  });

  test("the bare word 'all' stays a project HERE", () => {
    // Grammar cannot answer it: whether `all` means everything depends on
    // whether /workspaces/all exists, which is a question about the disk.
    // parseArgs stays free of the filesystem so it can be exercised without
    // one -- projects.ts:meansEveryTarget decides, for every caller.
    const args = parse("--stop", "all");
    assert.equal(args.project, "all");
    assert.equal(args.all, false);
  });
});

describe("parseArgs", () => {

  test("a lone '-' is a project name, not a flag", () => {
    // Only `--` prefixes are treated as options, so this must not be refused as
    // an unknown flag -- it falls through to the project slot.
    assert.equal(parse("-").project, "-");
  });

  test("--config with no value yields an empty config rather than eating the project", () => {
    refuses(["--config"], /usage:/);
  });
});

describe("every flag shape `Flags` declares round-trips", () => {
  // broker.ts builds `Flags[]` and flatMaps it into argv. If this grammar and
  // that type ever disagree, the failure is a devcontainer that does not start
  // with no indication why -- so enumerate the type's members here.
  //
  // Not all of them are reachable through the broker: it emits --config,
  // --rebuild, --stop and --ports, and has no op that carries --no-cache. That
  // shape is reachable only via `cli.sh desolate` -> desolate-run, and it is
  // enumerated here because the TYPE permits it, not because the broker sends
  // it. Which ops the broker really speaks is proven by execution, in
  // tests/integration/broker.
  const shapes: Array<{ flags: Flags[]; expect: Partial<ReturnType<typeof parseArgs>> }> = [
    { flags: [["--config", "/snap/dc.json"]], expect: { command: "run", config: "/snap/dc.json" } },
    { flags: [["--config", "/snap/dc.json"], "--rebuild"], expect: { rebuild: true } },
    { flags: [["--rebuild", "--no-cache"]], expect: { rebuild: true, noCache: true } },
    { flags: ["--stop"], expect: { command: "stop" } },
    { flags: ["--ports"], expect: { command: "ports" } },
  ];

  for (const { flags, expect } of shapes)
    test(JSON.stringify(flags), () => {
      const argv = [...flags.flatMap((f) => f), "myapp"];
      const parsed = parseArgs(argv);
      for (const [key, value] of Object.entries(expect))
        assert.equal(parsed[key as keyof typeof parsed], value);
      assert.equal(parsed.project, "myapp");
    });
});
