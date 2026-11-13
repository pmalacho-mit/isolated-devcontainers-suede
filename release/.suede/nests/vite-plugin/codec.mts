// also decoded in a webview, so it uses only what a browser has: btoa, not Buffer
import type { TestArtifactBase } from "vitest";
import type { Expect, Invoke, Table } from "../dsl.import.meta.vitest.ts";

export type EncodedArray = Encoded[];
export type EncodedObject = { [key: string]: Encoded };
export type Encoded = null | boolean | number | string | EncodedArray | EncodedObject;

export const DISPLAY = "namespace-tests:display";

/** What a test records for its display page, encoded so a `Map` or a `bigint` survives the trip. */
export type DisplayArtifact = TestArtifactBase & {
  type: typeof DISPLAY;
  /** The display page, relative to the test file. */
  page: string;
  actual: Encoded;
  expected?: Encoded;
  meta?: Encoded;
};

declare module "vitest" {
  interface TestArtifactRegistry {
    "namespace-tests:display": DisplayArtifact;
  }
}

const TYPED = [
  "Int8Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "Int16Array",
  "Uint16Array",
  "Int32Array",
  "Uint32Array",
  "Float32Array",
  "Float64Array",
  "BigInt64Array",
  "BigUint64Array",
] as const;
export type TypedArrayName = (typeof TYPED)[number];

const isTypedName = (tag: string): tag is TypedArrayName =>
  (TYPED as readonly string[]).includes(tag);

const binaryOf = (bytes: Uint8Array) => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return binary;
};

const toBase64 = (bytes: Uint8Array) => btoa(binaryOf(bytes));

const fromBase64 = (base64: string) =>
  Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));

// a cycle becomes `{ $ref: path }`
export function encode(value: unknown, seen: Map<object, string> = new Map(), path = "$"): Encoded {
  if (value === undefined) return { $type: "undefined" };

  if (typeof value === "bigint")
    return { $type: "bigint", value: value.toString() };

  if (typeof value === "number")
    return Number.isFinite(value)
      ? value
      : { $type: "number", value: String(value) };

  if (typeof value === "symbol")
    return { $type: "symbol", description: value.description ?? null };

  if (typeof value === "function")
    return { $type: "function", name: value.name || null };

  if (value === null || typeof value !== "object")
    return value as string | boolean;

  const ref = seen.get(value);
  if (ref !== undefined) return { $ref: ref };

  seen.set(value, path);
  const tag = Object.prototype.toString.call(value).slice(8, -1);
  if (isTypedName(tag)) {
    const view = value as ArrayBufferView;
    return {
      $type: tag,
      base64: toBase64(
        new Uint8Array(view.buffer, view.byteOffset, view.byteLength),
      ),
    };
  }

  if (value instanceof Date) return { $type: "Date", iso: value.toISOString() };

  if (value instanceof RegExp)
    return { $type: "RegExp", source: value.source, flags: value.flags };

  if (value instanceof Error)
    return {
      $type: "Error",
      name: value.name,
      message: value.message,
      stack: value.stack ?? null,
    };

  if (value instanceof Map)
    return {
      $type: "Map",
      entries: [...value].map(([k, v], i) => [
        encode(k, seen, `${path}.k${i}`),
        encode(v, seen, `${path}.v${i}`),
      ]),
    };

  if (value instanceof Set)
    return {
      $type: "Set",
      values: [...value].map((v, i) => encode(v, seen, `${path}[${i}]`)),
    };

  if (Array.isArray(value))
    return value.map((v, i) => encode(v, seen, `${path}[${i}]`));

  const out: { [key: string]: Encoded } = {};
  const proto = Object.getPrototypeOf(value);
  if (
    proto &&
    proto !== Object.prototype &&
    typeof proto.constructor?.name === "string"
  )
    out.$class = proto.constructor.name;

  for (const [k, v] of Object.entries(value))
    out[k] = encode(v, seen, `${path}.${k}`);

  return out;
}

declare namespace encode {
  /** what JSON already carries goes through unchanged */
  export type Plain = Expect<
    Invoke<typeof encode, [[1, "a", true]]>,
    "=",
    [1, "a", true]
  >;

  /** what it cannot carry becomes a tagged object */
  export type Tagged = Table<
    typeof encode,
    [
      [args: [value: undefined], expected: { $type: "undefined" }],
      [args: [value: 10n], expected: { $type: "bigint"; value: "10" }]
    ]
  >;

  /** nested values are encoded all the way down */
  export type Nested = Expect<
    Invoke<typeof encode, [{ a: [undefined] }]>,
    "=",
    { a: [{ $type: "undefined" }] }
  >;
}

// a `$ref` is left as it is
export function decode(value: Encoded): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(decode);
  const type = value.$type;
  switch (type) {
    case "undefined":
      return undefined;
    case "bigint":
      return BigInt(String(value.value));
    case "number":
      return Number(value.value);
    case "symbol":
      return Symbol(
        value.description === null ? undefined : String(value.description),
      );
    case "function":
      return Object.assign(() => {}, { name: value.name });
    case "Date":
      return new Date(String(value.iso));
    case "RegExp":
      return new RegExp(String(value.source), String(value.flags));
    case "Error":
      return Object.assign(new Error(String(value.message)), {
        name: value.name,
        stack: value.stack,
      });
    case "Map":
      return new Map(
        (value.entries as Encoded[][]).map(([k, val]) => [
          decode(k ?? null),
          decode(val ?? null),
        ]),
      );
    case "Set":
      return new Set((value.values as Encoded[]).map(decode));
  }
  if (typeof type === "string" && isTypedName(type)) {
    const bytes = fromBase64(String(value.base64));
    const Ctor = globalThis[type];
    return new Ctor(bytes.buffer);
  }
  const out: { [key: string]: unknown } = {};
  for (const [key, val] of Object.entries(value))
    if (key !== "$class") out[key] = decode(val);
  return out;
}

declare namespace decode {
  /** a tagged bigint comes back as a real one */
  export type BigIntBack = Expect<
    Invoke<typeof decode, [{ $type: "bigint"; value: "10" }]>,
    "=",
    10n
  >;

  /** `$class` is dropped: instances come back as plain objects */
  export type ClassBack = Expect<
    Invoke<typeof decode, [{ $class: "User"; id: 1 }]>,
    "=",
    { id: 1 }
  >;

  /** a round trip keeps what JSON alone would lose */
  export type RoundTrip = Expect<
    Invoke<typeof decode, [Invoke<typeof encode, [{ big: 10n }]>]>,
    "=",
    { big: 10n }
  >;
}

