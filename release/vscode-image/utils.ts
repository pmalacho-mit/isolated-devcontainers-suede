import {
  execFileSync,
  type ExecFileSyncOptionsWithStringEncoding,
} from "node:child_process";
import { pathToFileURL } from "node:url";

/** Was this module run as the program, rather than imported by another one?
 *
 *  A script that starts itself on import cannot be loaded by a test at all, so
 *  every executable module in this tree guards its entry point with this. */
export const isEntryPoint = (moduleUrl: string) =>
  process.argv[1] !== undefined &&
  moduleUrl === pathToFileURL(process.argv[1]).href;

export const identity = <T>(value: T) => value;
export const noop = () => {};

/**
 * Is `candidate` at or under `root`? Both must be absolute, and already
 * resolved if resolution matters to the caller (this is a string comparison,
 * not a filesystem question).
 *
 * The separator is the whole point: a bare `startsWith` accepts
 * `/workspaces/web-api` as being inside `/workspaces/web`, which is a
 * different project.
 */
export const isWithin = (root: string, candidate: string) =>
  candidate === root ||
  candidate.startsWith(root.endsWith("/") ? root : `${root}/`);

export type Expand<T> = T extends infer O ? { [K in keyof O]: O[K] } : never;

export type ExpandDeep<T> = T extends infer O
  ? { [K in keyof O]: ExpandDeep<O[K]> }
  : never;

export type ReplaceAll<
  Text extends string,
  Search extends string,
  Replacement extends string,
> = Search extends ""
  ? Text
  : Text extends `${infer Left}${Search}${infer Right}`
    ? `${Left}${Replacement}${ReplaceAll<Right, Search, Replacement>}`
    : Text;

export type JSONValue =
  | string
  | number
  | boolean
  | null
  | { [key: string]: JSONValue }
  | JSONValue[];

export type ItemFromSet<T extends Set<any> | ReadonlySet<any>> =
  T extends Set<infer Item>
    ? Item
    : T extends ReadonlySet<infer Item>
      ? Item
      : never;

export const readonlySet: <T extends Set<any>>(
  set: T,
) => ReadonlySet<ItemFromSet<T>> = identity;

export type ToReadonlySet<T extends Set<any>> = ReturnType<
  typeof readonlySet<T>
>;

export const nonNullObject = <T extends {}>(
  item: T | null,
): item is Exclude<
  Extract<T, { [key: string | number | symbol]: any }>,
  Array<any>
> => item !== null && !Array.isArray(item) && typeof item === "object";

export interface RunOptions {
  /** Suppress the command's own stdout. */
  quiet?: boolean;
  /** Kill the command after this long. Absent means "wait as long as it takes",
   *  which is only safe where the command cannot outlive its own reason. */
  timeoutMs?: number;
}

export const run = Object.assign(
  /** Run a command; return stdout. Throws on failure unless `allowFail`. */
  (
    cmd: string,
    args: string[],
    options: ExecFileSyncOptionsWithStringEncoding = { encoding: "utf8" },
    allowFail = false,
  ): string => {
    try {
      return execFileSync(cmd, args, options).trim();
    } catch (err: any) {
      if (allowFail) return "";
      throw err;
    }
  },
  {
    status: Object.assign(
      (
        cmd: string,
        args: string[],
        { quiet = false, timeoutMs }: RunOptions = {},
      ): number => {
        try {
          execFileSync(cmd, args, {
            stdio: ["ignore", quiet ? "ignore" : "inherit", "inherit"],
            timeout: timeoutMs,
          });
          return 0;
        } catch (err: any) {
          // A killed child reports a signal and no status; every caller of this
          // asks the same question of both, so a bound that fires reads as the
          // failure it is rather than as success.
          return err?.status ?? 1;
        }
      },
      {
        ok: (...params: Parameters<typeof run.status>) =>
          run.status(...params) === 0,
      },
    ),
  },
);
