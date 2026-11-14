// Names: one spelling each. A slug becomes a VM name, a hostname and a path, so it is
// validated once, here, and nothing downstream re-interprets it (move-to-vms.md section 2;
// v2's `owner/repo` as `owner__repo` needed a whole rule set, so v3 never encodes one).
import { createHash } from "node:crypto";
// In-source tests (suede.nests: `npm run test:nests`). Types only: erased when node runs this.
import type { Expect, Invoke, Table } from "../.suede/nests/dsl.import.meta.vitest.ts";

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

declare namespace isSlug {
  /** what a domain or workspace may be called: it becomes a VM name, a hostname and a path */
  export type Names = Table<typeof isSlug, [
    [args: [value: "acme"], expected: true],
    [args: [value: "issue-12"], expected: true],
    [args: [value: "Acme"], expected: false],
    [args: [value: "-acme"], expected: false],
    [args: [value: "acme-"], expected: false],
    [args: [value: "a--b"], expected: false],
    [args: [value: "a.b"], expected: false],
    [args: [value: "x234567890123456789012345678901234567890"], expected: true],
    [args: [value: "x2345678901234567890123456789012345678901"], expected: false],
  ]>;
}

declare namespace parseRepo {
  /** owner/name, and nothing that could leave the directory it names */
  export type Accepts = Expect<Invoke<typeof parseRepo, [value: "acme/widgets"]>, "=", { owner: "acme"; name: "widgets" }>;
  export type Refuses = Table<typeof parseRepo, [
    [args: [value: "acme"], expected: null],
    [args: [value: "acme/widgets/x"], expected: null],
    [args: [value: "../widgets"], expected: null],
    [args: [value: "acme/.."], expected: null],
    [args: [value: "acme/widgets.git"], expected: null],
    [args: [value: "-acme/widgets"], expected: null],
  ]>;
}

export const repoId = (repo: Repo) => `${repo.owner}/${repo.name}`;

/** Text as a slug: lower case, every run of anything else one dash, at most 40. */
const slugFrom = (text: string) =>
  text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+/, "").slice(0, 40).replace(/-+$/, "");

/** The names `clone` tries, in order, for the domain it makes a repository: the
 *  repository's own name, then owner and name together. A slug, never `owner/repo` itself
 *  (it is a VM label, a hostname and a path; see the top of this file). */
export const domainNamesFor = (repo: Repo): string[] =>
  [...new Set([slugFrom(repo.name), slugFrom(`${repo.owner}-${repo.name}`)])]
    .filter((name) => isSlug(name) && name !== "origin" && name !== "root");

declare namespace domainNamesFor {
  /** the repository's name first, lower-cased; then owner-name for when that is taken */
  export type Names = Table<typeof domainNamesFor, [
    [args: [repo: { owner: "acme"; name: "widgets" }], expected: ["widgets", "acme-widgets"]],
    [args: [repo: { owner: "pmalacho-mit"; name: "suede.nests" }], expected: ["suede-nests", "pmalacho-mit-suede-nests"]],
    [args: [repo: { owner: "Acme"; name: "My_App" }], expected: ["my-app", "acme-my-app"]],
    [args: [repo: { owner: "acme"; name: "a--b" }], expected: ["a-b", "acme-a-b"]],
  ]>;
  /** names a domain may not have are skipped: `origin` and `root` are remotes in every clone */
  export type Skips = Table<typeof domainNamesFor, [
    [args: [repo: { owner: "acme"; name: "origin" }], expected: ["acme-origin"]],
    [args: [repo: { owner: "acme"; name: "_" }], expected: ["acme"]],
  ]>;
}

/** A branch name desolate will carry across an owner boundary. Stricter than git's
 *  check-ref-format (which the importing side also runs): no leading dash, no shell or
 *  refspec metacharacters, so it is safe as an argv word and inside a refspec. */
export const isBranch = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 && value.length <= 200 &&
  /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) &&
  !value.includes("..") && !value.includes("//") && !value.endsWith("/") &&
  !value.endsWith(".lock") && !value.endsWith(".") && !value.includes("@{");

declare namespace isBranch {
  /** a branch an agent may name and the root may carry: safe as an argv word and in a refspec */
  export type Carries = Table<typeof isBranch, [
    [args: [value: "main"], expected: true],
    [args: [value: "feature/greet-by-name"], expected: true],
    [args: [value: "v1.2_rc-3"], expected: true],
  ]>;
  export type Refuses = Table<typeof isBranch, [
    [args: [value: "--upload-pack=touch x"], expected: false],
    [args: [value: "a..b"], expected: false],
    [args: [value: "a//b"], expected: false],
    [args: [value: "feature/"], expected: false],
    [args: [value: "x.lock"], expected: false],
    [args: [value: "x@{1}"], expected: false],
    [args: [value: "a b"], expected: false],
    [args: [value: "a;rm -rf"], expected: false],
    [args: [value: ""], expected: false],
  ]>;
}

export const isCommit = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{40}$/.test(value);

declare namespace isCommit {
  /** a full object id, lower case: never an abbreviation, never a ref */
  export type Ids = Table<typeof isCommit, [
    [args: [value: "0123456789abcdef0123456789abcdef01234567"], expected: true],
    [args: [value: "0123456789ABCDEF0123456789ABCDEF01234567"], expected: false],
    [args: [value: "0123456"], expected: false],
    [args: [value: "HEAD"], expected: false],
  ]>;
}

export const isLfsOid = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{64}$/.test(value);

const hex = (text: string, length: number) =>
  createHash("sha256").update(text).digest("hex").slice(0, length);

/** VM names are short and opaque: Lima's socket paths cap at 104 bytes, and two slugs of 40
 *  would not fit. The readable name travels as a label. `instance` separates stacks on one
 *  host (a test run beside the real one). */
export const rootVmName = (instance: string) => `dsl-${instance}-root`;
/** The git VM (host/git-vm.ts): where the person types git, in clones of their own. */
export const gitVmName = (instance: string) => `dsl-${instance}-git`;
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
/** The approval page (host/approve-web.ts), served by the host daemon itself on the editors'
 *  port. A name of its own, not under ROOT_HOSTNAME: the dashboard's content comes from the
 *  root, and a cookie it set for its own domain would be sent to names under it. */
export const APPROVE_HOSTNAME = "desolate-approve.localhost";
/** The git terminal (host/git-web.ts): a bash in the git VM, in a browser tab. */
export const GIT_HOSTNAME = "desolate-git.localhost";

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

/** The root UI: the state service in the root VM, which serves the dashboard. It is on the
 *  root VM's loopback; the host's forwarder carries it on the editors' port, at
 *  ROOT_HOSTNAME. (The root has no editor: nothing in the root opens what an agent wrote
 *  with anything but git and desolate's own code.) */
export const ROOT_UI = { port: 31590 } as const;
