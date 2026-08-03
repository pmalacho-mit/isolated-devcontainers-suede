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
      config: undefined,
      rebuild: false,
      noCache: false,
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

  test("a lone '-' is a project name, not a flag", () => {
    // Only `--` prefixes are treated as options, so this must not be refused as
    // an unknown flag -- it falls through to the project slot.
    assert.equal(parse("-").project, "-");
  });

  test("--config with no value yields an empty config rather than eating the project", () => {
    refuses(["--config"], /usage:/);
  });
});

describe("every flag shape the broker can emit round-trips", () => {
  // broker.ts builds `Flags[]` and flatMaps it into argv. If this grammar and
  // that type ever disagree, the failure is a devcontainer that does not start
  // with no indication why -- so enumerate the type's members here.
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
