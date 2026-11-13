// Who may reach a page of desolate's own, by the headers a browser sends: the checks the
// workspace's editor (workspace/editor-gate.ts), the approval page and the git terminal
// (host/approve-web.ts, host/git-web.ts) and the dashboard (root/stated.ts) share. What each
// check is for is said in editor-gate.ts, where it was first worked out.
//
// In shared/, not workspace/: the host daemon serves two of those pages, and restarts itself
// when the code it runs changes, by a hash of host/, host/vm/ and shared/ (daemon.ts).
import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
// In-source tests (suede.nests: `npm run test:nests`). Types only: erased when node runs this.
import type { Expect, Invoke, Table } from "../.suede/nests/dsl.import.meta.vitest.ts";

/** Is a secret what it should be, in constant time? Compared as UTF-8 bytes: two strings of
 *  one length can differ in bytes ("é" is two), and timingSafeEqual throws on unequal
 *  lengths, which made a 500 of a wrong token. */
export const sameSecret = (given: string, expected: string): boolean => {
  const a = Buffer.from(given, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && b.length > 0 && timingSafeEqual(a, b);
};

declare namespace sameSecret {
  export type Cases = Table<typeof sameSecret, [
    [args: [given: "abc123", expected: "abc123"], expected: true],
    [args: [given: "abc124", expected: "abc123"], expected: false],
    [args: [given: "abc12", expected: "abc123"], expected: false],
    /** one length in characters, another in bytes: false, not a thrown RangeError */
    [args: [given: "abcé", expected: "abcd"], expected: false],
    [args: [given: "", expected: ""], expected: false],
  ]>;
}

/** The hostname of a Host header or an Origin, lowercased; "" for none. */
export const hostnameOf = (value: string | undefined, isOrigin = false): string => {
  if (!value) return "";
  try {
    return new URL(isOrigin ? value : `http://${value}`).hostname.toLowerCase();
  } catch {
    return "\0unparseable";
  }
};

/** A top-level GET of the editor's page whose address carries this editor's token: what
 *  following the editor's own address (from the dashboard, or `desolate editor`) sends. */
export const openedWithToken = (request: { method?: string; url?: string; headers: IncomingMessage["headers"] }, token: string | null): boolean => {
  if (!token || request.method !== "GET" || request.headers["sec-fetch-mode"] !== "navigate" || request.headers["sec-fetch-dest"] !== "document") return false;
  let url: URL;
  try {
    url = new URL(request.url ?? "", "http://gate");
  } catch {
    return false;
  }
  const given = url.searchParams.get("tkn") ?? "";
  return url.pathname === "/" && sameSecret(given, token);
};

/** Why this request may not reach the editor, or undefined when it may. `opened`: it is a
 *  navigation that carried the editor's token (openedWithToken). */
export const refusal = (editorHost: string, headers: IncomingMessage["headers"], opened = false): { status: number; why: string } | undefined => {
  if (hostnameOf(headers.host) !== editorHost) return { status: 421, why: `this is the editor of ${editorHost}; open it by that name (\`desolate editor\` prints the address)` };
  const site = String(headers["sec-fetch-site"] ?? "");
  if (site !== "" && site !== "same-origin" && site !== "none" && !opened) return { status: 403, why: `a request another site started (Sec-Fetch-Site: ${site.slice(0, 40)})` };
  if (headers.origin !== undefined && hostnameOf(String(headers.origin), true) !== editorHost) return { status: 403, why: `a request from another origin (${String(headers.origin).slice(0, 80).replace(/[^\x20-\x7e]/g, "?")})` };
  return undefined;
};

declare namespace hostnameOf {
  export type Cases = Table<typeof hostnameOf, [
    [args: [value: "Acme-Web.Localhost:31580"], expected: "acme-web.localhost"],
    [args: [value: "http://git.desolate.localhost:31580", isOrigin: true], expected: "git.desolate.localhost"],
    [args: [value: undefined], expected: ""],
    [args: [value: "a b"], expected: "\0unparseable"],
  ]>;
}

declare namespace refusal {
  /** the editor's own name, typed or same-origin: let through */
  export type Allowed = [
    Expect<Invoke<typeof refusal, [editorHost: "e.localhost", headers: { host: "e.localhost:31580"; "sec-fetch-site": "same-origin"; origin: "http://e.localhost:31580" }]>, "=", undefined>,
    Expect<Invoke<typeof refusal, [editorHost: "e.localhost", headers: { host: "e.localhost:31580" }]>, "=", undefined>,
    /** another site, but a navigation that carried the token */
    Expect<Invoke<typeof refusal, [editorHost: "e.localhost", headers: { host: "e.localhost"; "sec-fetch-site": "cross-site" }, opened: true]>, "=", undefined>,
  ];
  export type Refused = [
    Expect<Invoke<typeof refusal, [editorHost: "e.localhost", headers: { host: "other.localhost" }]>, "=", { status: 421; why: "this is the editor of e.localhost; open it by that name (`desolate editor` prints the address)" }>,
    Expect<Invoke<typeof refusal, [editorHost: "e.localhost", headers: { host: "e.localhost"; "sec-fetch-site": "cross-site" }]>, "=", { status: 403; why: "a request another site started (Sec-Fetch-Site: cross-site)" }>,
    Expect<Invoke<typeof refusal, [editorHost: "e.localhost", headers: { host: "e.localhost"; origin: "http://evil.example" }]>, "=", { status: 403; why: "a request from another origin (http://evil.example)" }>,
  ];
}

declare namespace openedWithToken {
  export type Cases = Table<typeof openedWithToken, [
    [args: [request: { method: "GET"; url: "/?tkn=0123abcd"; headers: { "sec-fetch-mode": "navigate"; "sec-fetch-dest": "document" } }, token: "0123abcd"], expected: true],
    [args: [request: { method: "GET"; url: "/?tkn=0123abce"; headers: { "sec-fetch-mode": "navigate"; "sec-fetch-dest": "document" } }, token: "0123abcd"], expected: false],
    /** a fetch, a frame, another path: not the dashboard's "Open editor" */
    [args: [request: { method: "GET"; url: "/?tkn=0123abcd"; headers: { "sec-fetch-mode": "cors"; "sec-fetch-dest": "empty" } }, token: "0123abcd"], expected: false],
    [args: [request: { method: "GET"; url: "/?tkn=0123abcd"; headers: { "sec-fetch-mode": "navigate"; "sec-fetch-dest": "iframe" } }, token: "0123abcd"], expected: false],
    [args: [request: { method: "GET"; url: "/x?tkn=0123abcd"; headers: { "sec-fetch-mode": "navigate"; "sec-fetch-dest": "document" } }, token: "0123abcd"], expected: false],
    [args: [request: { method: "GET"; url: "/?tkn=0123abcd"; headers: { "sec-fetch-mode": "navigate"; "sec-fetch-dest": "document" } }, token: null], expected: false],
  ]>;
}
