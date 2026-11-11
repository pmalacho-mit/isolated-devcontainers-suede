// Names: one spelling each. A slug becomes a VM name, a hostname and a path, so it is
// validated once, here, and nothing downstream re-interprets it (move-to-vms.md section 2;
// v2's `owner/repo` as `owner__repo` needed a whole rule set, so v3 never encodes one).
import { createHash } from "node:crypto";

export const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** GitHub's own rules, narrowed: no leading dot or dash, no "..", no ".git" suffix. */
const REPO_PART = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/;

export const isSlug = (value: unknown): value is string =>
  typeof value === "string" && SLUG.test(value) && !value.endsWith("-") && !value.includes("--");

export type Repo = { owner: string; name: string };

export const parseRepo = (value: unknown): Repo | null => {
  if (typeof value !== "string") return null;
  const parts = value.split("/");
  if (parts.length !== 2) return null;
  const [owner, name] = parts as [string, string];
  for (const part of [owner, name])
    if (!REPO_PART.test(part) || part.includes("..") || part.endsWith(".git") || part.endsWith(".")) return null;
  return { owner, name };
};

export const repoId = (repo: Repo) => `${repo.owner}/${repo.name}`;

/** A branch name desolate will carry across an owner boundary. Stricter than git's
 *  check-ref-format (which the importing side also runs): no leading dash, no shell or
 *  refspec metacharacters, so it is safe as an argv word and inside a refspec. */
export const isBranch = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 && value.length <= 200 &&
  /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) &&
  !value.includes("..") && !value.includes("//") && !value.endsWith("/") &&
  !value.endsWith(".lock") && !value.endsWith(".") && !value.includes("@{");

export const isCommit = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{40}$/.test(value);

export const isLfsOid = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{64}$/.test(value);

const hex = (text: string, length: number) =>
  createHash("sha256").update(text).digest("hex").slice(0, length);

/** VM names are short and opaque: Lima's socket paths cap at 104 bytes, and two slugs of 40
 *  would not fit. The readable name travels as a label. `instance` separates stacks on one
 *  host (a test run beside the real one). */
export const rootVmName = (instance: string) => `dsl-${instance}-root`;
export const workspaceVmName = (instance: string, domain: string, workspace: string) =>
  `dsl-${instance}-${hex(`${domain}\0${workspace}`, 10)}`;

/** One hostname per surface (section 4.4). The hex is not a secret: it keeps two stacks, or
 *  a recreated workspace, from sharing a cookie jar by name. */
export const surfaceHex = (instance: string, domain: string, workspace: string) =>
  hex(`${instance}\0${domain}\0${workspace}`, 6);
export const devHostname = (instance: string, domain: string, workspace: string) =>
  `${domain}-${workspace}-${surfaceHex(instance, domain, workspace)}.localhost`;
export const editorHostname = (instance: string, domain: string, workspace: string) =>
  `${domain}-${workspace}-editor-${surfaceHex(instance, domain, workspace)}.localhost`;
export const ROOT_HOSTNAME = "desolate.localhost";

/** A workspace's editor (P1: it runs in the workspace VM). In the VM, the editor's server
 *  listens on loopback at `server`, and editor-gate.ts in front of it at `gate`; the host's
 *  forwarder reaches only the gate, on one host port, by the editor's own hostname. Neither
 *  in-VM port is ever forwarded as a dev-server port. */
export const EDITOR = { server: 31580, gate: 31581 } as const;
export const editorHostPort = () => {
  const port = Number(process.env.DESOLATE_EDITOR_PORT ?? 31581);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error(`DESOLATE_EDITOR_PORT must be a port from 1024 to 65535, not '${process.env.DESOLATE_EDITOR_PORT}'`);
  return port;
};

/** The root UI (section 4.8): the state service in the root VM, and the root's editor. Both
 *  are on the root VM's loopback; the host's forwarder carries them on the editors' port,
 *  the dashboard at ROOT_HOSTNAME and the root editor at ROOT_EDITOR_HOSTNAME. */
export const ROOT_UI = { port: 31590 } as const;
export const ROOT_EDITOR_HOSTNAME = "desolate-editor.localhost";
