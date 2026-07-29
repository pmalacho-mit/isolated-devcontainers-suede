/// <reference types="node" />
/**
 * typescript-cli-suede — declare a CLI's arguments; get parsing, typing, and
 * `--help` from the declaration.
 *
 * ```ts
 * const args = cli(
 *   "Render diagrams.",
 *   cli.flag(["out", "o"], "Where to write"),        // string | undefined
 *   cli.flag(["check", "c"], "Check only", false),   // boolean
 *   cli.flags(["embed", "e"], "Files to embed"),     // string[]
 * );
 *
 * const { out, check, embed } = args;   // flags — by longform name
 * const files = [...args];              // positional arguments
 * ```
 *
 * A flag's *type* comes from how you declared it: a default makes the value
 * guaranteed, no default makes it `T | undefined`, `cli.flags` makes it an
 * array, and an options list narrows it to that union (and is validated at
 * parse time). See {@link Result.Cli} for how the returned object behaves —
 * particularly that named properties and iteration expose different things.
 */
import { fileURLToPath } from "node:url";
import { flag, flags, is, type Flag } from "./flag.js";

export class InvalidOptionError extends Error {
  public readonly name = "InvalidOptionError";
  public readonly flag: string;
  public readonly received: string;
  public readonly options: (string | number)[];

  constructor(flag: string, received: string, options: (string | number)[]) {
    super(
      `--${flag}: invalid value ${JSON.stringify(received)}. ` +
        `Expected one of: ${options.map((o) => JSON.stringify(o)).join(", ")}`,
    );
    this.flag = flag;
    this.received = received;
    this.options = options;
  }
}

export namespace Result {
  /** The value a flag carries: element type of `options` if present, else the `default`'s type. */
  type _Value<F> = F extends { options?: (infer T)[] | undefined }
    ? T
    : F extends { default?: infer D }
      ? Exclude<D, undefined>
      : never;

  /**
   * Maps a `Flag` descriptor to the TypeScript type of its parsed value:
   *   - `multiple: true`              → `T[]`  (always an array, never undefined)
   *   - `multiple: false, default: T` → `T`    (guaranteed present)
   *   - `multiple: false, no default` → `T | undefined`
   *
   * Computed from F's structural shape rather than by re-inferring the Config
   * type parameter — `Config` is not uniquely recoverable from `Flag<T,L,Config>`
   * because `Config["default"]` only affects whether the `default` property is
   * required vs. optional, and `infer Config` cannot invert that.
   */
  type _Flag<F extends Flag> = F["multiple"] extends true
    ? _Value<F>[]
    : undefined extends F["default"]
      ? _Value<F> | undefined
      : _Value<F>;

  /**
   * One property per flag, keyed by its **longform** name — never its shorthand.
   * `flag(["out", "o"], …)` is read as `result.out`, not `result.o`.
   */
  export type Named<Flags extends Flag[]> = {
    [F in Flags[number] as F["longform"]]: _Flag<F>;
  };

  /**
   * The leftovers: every argument that wasn't a flag or a flag's value, plus
   * everything after a bare `--`, in the order they were given.
   *
   * These are *not* named properties — there is nothing to name them after — so
   * they are reached by index or by iterating:
   *
   *   const files = [...result];   // string[]  ← the usual way
   *   result[0];                   // string | undefined
   *   for (const file of result) …
   *
   * Array destructuring (`const [first] = result`) works, but inherits
   * TypeScript's usual blind spot: `first` is typed `string` while an argv with
   * no positionals hands back `undefined`. Index or spread instead — those are
   * honest about it.
   */
  export interface Positional extends Iterable<string> {
    readonly [n: number]: string | undefined;
  }

  /**
   * What `cli(...)` hands back: flag values as named properties, positional
   * arguments through iteration, and `help()`.
   *
   * ```ts
   * const result = cli(
   *   "Do the thing.",
   *   cli.flag(["out", "o"], "Where to write"),          // string | undefined
   *   cli.flag(["check", "c"], "Check only", false),     // boolean  (has a default)
   *   cli.flags(["embed", "e"], "Files to embed"),       // string[] (multiple)
   * );
   *
   * const { out, check, embed } = result;   // named — flags only
   * const files = [...result];              // positional — everything else
   * ```
   *
   * Given `myscript a.ts --out r.md b.ts --embed x.md -- --literal`:
   *
   * | | |
   * | --- | --- |
   * | `result.out` | `"r.md"` |
   * | `result.embed` | `["x.md"]` |
   * | `result.check` | `false` (from the default) |
   * | `[...result]` | `["a.ts", "b.ts", "--literal"]` |
   *
   * **The two halves do not overlap**, which is the part worth remembering:
   *
   * - Spreading with `[...]` (array/iterable spread) yields the *positionals*.
   * - Spreading with `{...}` yields the *flags* — as do `Object.keys`,
   *   `JSON.stringify`, and anything else that walks own enumerable properties.
   *   Positionals are served by a `Proxy`, not stored as properties, so they are
   *   invisible to all of those.
   * - There is no `length`, and `Array.isArray` is `false`. Use `[...result]`
   *   first if you want array methods.
   *
   * A flag named `help` — or one whose longform is all digits — would be
   * shadowed by `help()` and by positional indexing respectively.
   */
  export type Cli<Flags extends Flag[]> = Named<Flags> &
    Positional & {
      /**
       * The generated usage text: every flag with its description and default,
       * plus `-h, --help`. Printing it yourself is useful when you reject the
       * arguments for a reason the parser can't know about.
       */
      help: () => string;
    };
}

export const help = Object.assign(
  (description: string, flags: Flag[]) => {
    const scriptName = process.argv[1]?.split("/").pop() ?? "script";
    const rows = [...flags.map(help.flag), help.message()];
    const pad = Math.max(...rows.map(([left]) => left.length));
    return [
      `Usage: ${scriptName} [options] [args...]`,
      "",
      description,
      "",
      "Options:",
      ...rows.map(([left, right]) => `  ${left.padEnd(pad)}  ${right}`),
    ].join("\n");
  },
  {
    spacing: { shorthand: " ".repeat(3) },

    flag: (flag: Flag): [string, string] => {
      const left =
        is(flag, "string") || is(flag, "number")
          ? help.value(flag)
          : is(flag, "boolean")
            ? help.boolean(flag)
            : undefined;

      if (!left)
        throw new Error(`Unsupported flag type for --${flag.longform}`);

      const defaultSuffix =
        flag.default !== undefined
          ? ` (default: ${JSON.stringify(flag.default)})`
          : "";
      return [left, `${flag.description}${defaultSuffix}`];
    },

    message: (): [string, string] => [`-h, --help`, "Show this help message"],

    boolean: (flag: Flag<boolean>) => {
      const positive = flag.shorthand
        ? `-${flag.shorthand}, --${flag.longform}`
        : `${help.spacing.shorthand} --${flag.longform}`;
      const negative = flag.negation?.shorthand
        ? `-${flag.negation.shorthand}, --${flag.negation ?? `no-${flag.longform}`}`
        : `--${flag.negation ?? `no-${flag.longform}`}`;
      return `${positive} / ${negative}`;
    },

    value: (flag: Flag<string | number>) => {
      const short = flag.shorthand
        ? `-${flag.shorthand},`
        : help.spacing.shorthand;
      const hint =
        Array.isArray(flag.options) && flag.options.length > 0
          ? flag.multiple
            ? ` <${flag.options.join("|")}>...`
            : ` <${flag.options.join("|")}>`
          : is(flag, "number")
            ? flag.multiple
              ? " <number>..."
              : " <number>"
            : flag.multiple
              ? " ..."
              : " <value>";
      return `${short} --${flag.longform}${hint}`;
    },
  },
);

type FlagEntry =
  | { flag: Flag<string | number> }
  | { flag: Flag<boolean>; positive: boolean };

type FlagMap = Map<string, FlagEntry>;

const flagMap = Object.assign(
  (flags: Flag[]): FlagMap => {
    const map = new Map<string, FlagEntry>();

    for (const flag of flags)
      if (is(flag, "string") || is(flag, "number"))
        flagMap.set(map, flag, { flag });
      else if (is(flag, "boolean")) {
        flagMap.set(map, flag, { flag, positive: true });
        const negation = flag.negation ?? { longform: `no-${flag.longform}` };
        flagMap.set(map, negation, { flag, positive: false });
      }

    return map;
  },
  {
    set: (
      map: Map<string, FlagEntry>,
      { longform, shorthand }: Pick<Flag, "longform" | "shorthand">,
      entry: FlagEntry,
    ) => {
      if (map.has(`--${longform}`))
        throw new Error(`Duplicate longform flag: --${longform}`);
      map.set(`--${longform}`, entry);
      if (!shorthand) return;
      if (map.has(`-${shorthand}`))
        throw new Error(`Duplicate shorthand flag: -${shorthand}`);
      map.set(`-${shorthand}`, entry);
    },
  },
);

export type Parsed = { values: Record<string, unknown>; positional: string[] };

export const parse = Object.assign(
  (argv: string[], flags: Flag[]): Parsed => {
    const map = flagMap(flags);
    const values: Parsed["values"] = {};
    const positional: Parsed["positional"] = [];

    for (const { multiple, longform } of flags)
      if (multiple) values[longform] = [];

    let pastSeparator = false;
    for (let i = 0; i < argv.length; i++) {
      const arg = argv[i];

      if (arg === "--" && !pastSeparator) {
        pastSeparator = true;
        continue;
      }

      if (pastSeparator || !arg.startsWith("-")) {
        positional.push(arg);
        continue;
      }

      const entry = map.get(parse.named(arg));
      if (!entry) continue;

      if (is(entry.flag, "boolean")) {
        values[entry.flag.longform] = parse.boolean(arg, entry, entry.flag);
        continue;
      }

      const consumed = parse.raw(argv, i);
      if (consumed === undefined) continue;

      const { flag } = entry;
      const { longform, multiple } = flag;
      const value = parse.value(flag, consumed[0]);

      if (multiple) (values[longform] as (string | number)[]).push(value);
      else values[longform] = value;

      i = consumed[1];
    }

    return { values, positional };
  },
  {
    named: (arg: string) => {
      const equal = arg.indexOf("=");
      return equal !== -1 ? arg.slice(0, equal) : arg;
    },
    inline: (arg: string) => {
      const equal = arg.indexOf("=");
      return equal !== -1 ? arg.slice(equal + 1) : undefined;
    },
    boolean: (arg: string, entry: FlagEntry, _: Flag<boolean>) => {
      if (parse.inline(arg))
        throw new Error(
          `Boolean flag --${entry.flag.longform} does not take a value`,
        );
      return (entry as Extract<FlagEntry, { flag: Flag<boolean> }>).positive;
    },
    raw: (argv: string[], i: number): [string, number] | undefined => {
      const inline = parse.inline(argv[i]);
      if (inline !== undefined) return [inline, i];
      if (i + 1 < argv.length && !argv[i + 1].startsWith("-"))
        return [argv[i + 1], i + 1];
      return undefined;
    },

    value: (flag: Flag<string | number>, raw: string) => {
      const parsed = is(flag, "number") ? Number(raw) : raw;

      if (typeof parsed === "number" && Number.isNaN(parsed))
        throw new Error(
          `--${flag.longform}: expected a number, got ${JSON.stringify(raw)}`,
        );

      const { options } = flag;

      if (
        Array.isArray(options) &&
        !(options as (string | number)[]).includes(parsed)
      )
        throw new InvalidOptionError(flag.longform, raw, options);

      return parsed;
    },
  },
);

const applyDefaults = (
  values: Record<string, unknown>,
  flags: Flag[],
): void => {
  for (const f of flags) {
    const fa = f as { default?: unknown };
    if (fa.default === undefined) continue;
    if (f.multiple && (values[f.longform] as unknown[]).length === 0) {
      values[f.longform] = Array.isArray(fa.default)
        ? [...fa.default]
        : [fa.default];
    } else if (!f.multiple && values[f.longform] === undefined) {
      values[f.longform] = fa.default;
    }
  }
};

/**
 * Layers positional access and `help()` over the parsed flag values.
 *
 * A `Proxy` rather than extra properties on the object, so the two access
 * surfaces stay disjoint: `Object.keys` / `{...spread}` / `JSON.stringify` see
 * only the flags, while indexing and `[...spread]` see only the positionals.
 * Merging them would mean guessing whether `result[0]` meant a flag or an
 * argument, and would put `help` into every object spread.
 */
const withPositional = <T extends object>(
  values: T,
  positional: string[],
  help: () => string,
): T =>
  new Proxy(values, {
    get(target, prop) {
      if (prop === "help") return help;
      if (typeof prop === "string" && /^\d+$/.test(prop))
        return positional[Number(prop)];
      if (prop === Symbol.iterator)
        return positional[Symbol.iterator].bind(positional);
      return (target as Record<PropertyKey, unknown>)[prop];
    },
  });

/**
 * Parse an explicit argv. `cli()` is this with `process.argv.slice(2)` — use
 * `main` directly to test a CLI without spawning a process.
 *
 * Exits the process after printing usage if `--help` / `-h` is present.
 *
 * Parsing rules:
 * - `--flag value`, `--flag=value`, and shorthand `-f value` / `-f=value`.
 * - Boolean flags take no value; each also accepts a negation form, `--no-<name>`
 *   unless one was named explicitly.
 * - Repeatable flags (`cli.flags`) accumulate in order of appearance.
 * - A bare `--` sends every remaining argument to the positionals, even if it
 *   looks like a flag.
 * - Unrecognized `-…` arguments are ignored rather than collected as positional.
 *
 * @returns flag values as named properties, positionals via iteration — see
 * {@link Result.Cli}.
 */
export const main = <Flags extends Flag[]>(
  argv: string[],
  description: string,
  flags: [...Flags],
) => {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(help(description, flags));
    process.exit(0);
  }

  const { values, positional } = parse(argv, flags);
  applyDefaults(values, flags);

  type Expand<T> = T extends infer O ? { [K in keyof O]: O[K] } : never;

  return withPositional(
    values as Result.Cli<Flags>,
    positional,
    help.bind(null, description, flags),
  ) satisfies Result.Cli<Flags> as unknown as Expand<Result.Cli<Flags>>;
};

/**
 * Declare a CLI's arguments and parse `process.argv`.
 *
 * ```ts
 * cli.onEntry(import.meta.url, () => {
 *   const args = cli(
 *     "Render diagrams.",
 *     cli.flag(["out", "o"], "Where to write"),        // string | undefined
 *     cli.flag(["check", "c"], "Check only", false),   // boolean
 *     cli.flags(["embed", "e"], "Files to embed"),     // string[]
 *   );
 *
 *   const { out, check, embed } = args;   // flags, by longform name
 *   const files = [...args];              // positional arguments
 *   if (files.length === 0) console.error(args.help());
 * });
 * ```
 *
 * The two ways of reading `args` are disjoint — named properties are flags,
 * iteration yields positionals. {@link Result.Cli} spells out the details.
 *
 * `--help` / `-h` prints usage and exits before this returns.
 */
export const cli = Object.assign(
  <const Flags extends Flag[]>(description: string, ...flags: Flags) =>
    main<Flags>(process.argv.slice(2), description, flags),
  {
    flag,
    flags,
    /**
     * True when this module is the script node was invoked with — the ESM
     * equivalent of `require.main === module`. Lets a file be both an importable
     * module and a runnable command.
     */
    entry: (import_meta_url: string) =>
      process.argv[1] !== undefined &&
      fileURLToPath(import_meta_url) === process.argv[1],
    /** {@link cli.entry}, as a guard around the body: runs `callback` only when invoked directly. */
    onEntry: (import_meta_url: string, callback: () => any) =>
      cli.entry(import_meta_url) && callback(),
  },
);
