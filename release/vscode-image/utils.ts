import {
  execFileSync,
  type ExecFileSyncOptionsWithStringEncoding,
} from "node:child_process";

export const identity = <T>(value: T) => value;
export const noop = () => {};

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
      (cmd: string, args: string[], quiet = false): number => {
        try {
          execFileSync(cmd, args, {
            stdio: ["ignore", quiet ? "ignore" : "inherit", "inherit"],
          });
          return 0;
        } catch (err: any) {
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
