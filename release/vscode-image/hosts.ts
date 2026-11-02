/**
 * hosts.ts -- the name a browser reaches each surface by: one host per
 * target, and one for the outer editor, never 127.0.0.1.
 *
 * Every editor and dev server this stack shows is on the Mac's loopback, on
 * different ports, and a browser's cookie jar ignores the port (RFC 6265
 * s8.5). Measured against the outer editor's VSCodium server: `?tkn=` sets
 * `vscode-tkn=<token>; SameSite=Lax` -- not HttpOnly, because the workbench
 * reads it from document.cookie -- and that cookie alone authenticates. So any
 * page on 127.0.0.1, at any port -- a project's dev server, which `desolate`
 * prints for you to open -- read the outer editor's token and every project
 * editor's. And 127.0.0.1:8081 and 127.0.0.1:3000 are one SITE as well as one
 * host, so a Lax cookie went along with that page's requests too.
 *
 * `*.localhost` resolves to loopback in Chrome and Firefox with nothing
 * configured (RFC 6761 s6.3), and each name is a site of its own: a cookie set
 * for one is neither readable from nor sent by a page on another. That holds
 * only if no page can be SERVED under another target's name, and a port
 * answers whatever name a browser used to reach it -- so the ingress takes
 * each forwarded port's requests for its own target's name alone (ingress.py
 * `expected_host`, the same function as hostOf below), and the outer editor
 * sits behind a gate that refuses what another site sends it (editor-gate.ts).
 *
 * A target's name is `<readable>-<16 hex>.localhost`: the hex is of its
 * namespace, so two targets never share a host, however their names are
 * spelled; the readable part is for the address bar and decides nothing. One
 * DNS label, never a dotted name -- a project named `my.app` would otherwise
 * be a subdomain of `app.localhost`, and whether two names are one site would
 * turn on the public suffix list. The outer editor's has no hex, so no
 * target's can be it.
 */
import { createHash } from "node:crypto";

/** The outer editor's host. cli.sh `EDITOR_HOST` says the same. */
export const EDITOR_HOST = "desolate.localhost";

/** The host a target is reached at, from its namespace (Target.namespace --
 *  what the ingress reads as a forward's owner). */
export const hostOf = (namespace: string): string => {
  const readable = namespace.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+/, "").slice(0, 40).replace(/-+$/, "");
  const digest = createHash("sha256").update(namespace, "utf8").digest("hex").slice(0, 16);
  return `${readable ? `${readable}-` : ""}${digest}.localhost`;
};

/** The origin a target's port is opened at. */
export const originOf = (namespace: string, hostPort: number): string => `http://${hostOf(namespace)}:${hostPort}`;
