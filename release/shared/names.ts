// Names: one spelling each. A slug becomes a VM name, a hostname and a path, so it is
// validated once, here, and nothing downstream re-interprets it (move-to-vms.md section 2;
// v2's `owner/repo` as `owner__repo` needed a whole rule set, so v3 never encodes one).
import { createHash } from "node:crypto";
// In-source tests (suede.nests: `npm run test:nests`). Types only: erased when node runs this.
import type { Expect, Invoke, Table } from "../.suede/nests/dsl.import.meta.vitest.ts";

export const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** GitHub's own rules, narrowed: no leading dot or dash, no "..", no ".git" suffix. */
const REPO_PART = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/;

/** At most one `--`: it is the separator in a domain named `owner--repo`, which clone makes,
 *  and a slug's single dashes collapse runs, so it is never ambiguous. Never `xn--` first: a
 *  hostname label that starts so is punycode to a browser. */
export const isSlug = (value: unknown): value is string =>
  typeof value === "string" && SLUG.test(value) && !value.endsWith("-") && value.split("--").length <= 2 && !value.startsWith("xn--") && !/-{3}/.test(value);

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
    [args: [value: "acme--widgets"], expected: true],
    [args: [value: "a--b--c"], expected: false],
    [args: [value: "a---b"], expected: false],
    [args: [value: "xn--widgets"], expected: false],
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

/** The domain `clone` makes a repository: `owner--repo`, each part a slug (its runs of
 *  anything else one dash, so `--` is only ever the separator). Too long for a slug: cut, and
 *  a hash of the whole keeps it apart from another cut the same way. Never `owner/repo`
 *  itself: a domain's name is a VM label, a hostname and a path. */
export const domainNameFor = (repo: Repo): string => {
  const part = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "x";
  let name = `${part(repo.owner)}--${part(repo.name)}`;
  if (name.startsWith("xn--")) name = `gh-${name}`;
  if (name.length > 40) name = `${name.slice(0, 33).replace(/-+$/, "")}-${hex(repoId(repo).toLowerCase(), 6)}`;
  return name;
};

declare namespace domainNameFor {
  /** owner and name, a double dash between */
  export type Names = Table<typeof domainNameFor, [
    [args: [repo: { owner: "acme"; name: "widgets" }], expected: "acme--widgets"],
    [args: [repo: { owner: "pmalacho-mit"; name: "suede.nests" }], expected: "pmalacho-mit--suede-nests"],
    [args: [repo: { owner: "Acme"; name: "My__App" }], expected: "acme--my-app"],
    [args: [repo: { owner: "acme"; name: "a--b" }], expected: "acme--a-b"],
    [args: [repo: { owner: "xn"; name: "app" }], expected: "gh-xn--app"],
  ]>;
}

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
/** What this stack's names end in: `localhost`, or, for a stack run inside a desolate
 *  workspace (developing desolate there), that workspace's own dev name: the outer stack
 *  routes it and every name under it to that workspace (host/daemon.ts), and a browser on the
 *  Mac resolves every `*.localhost` name to loopback. Inside the workspace, the outer stack
 *  gives it as DESOLATE_DEV_HOSTNAME:
 *    DESOLATE_HOSTNAME_SUFFIX=$DESOLATE_DEV_HOSTNAME desolate bootstrap
 *  Everything under it is that workspace's (its domain's), the inner stack's pages included. */
export const isLocalhostSuffix = (value: unknown): value is string =>
  typeof value === "string" && value.length <= 120 && /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)*localhost$/.test(value);
export const HOSTNAME_SUFFIX = (() => {
  const value = process.env.DESOLATE_HOSTNAME_SUFFIX || "localhost";
  if (!isLocalhostSuffix(value)) throw new Error(`DESOLATE_HOSTNAME_SUFFIX must be localhost or a name under it, not '${value}'`);
  return value;
})();
export const devHostname = (instance: string, domain: string, workspace: string) =>
  `${domain}-${workspace}-${surfaceHex(instance, domain, workspace)}.${HOSTNAME_SUFFIX}`;
export const editorHostname = (instance: string, domain: string, workspace: string) =>
  `${domain}-${workspace}-editor-${surfaceHex(instance, domain, workspace)}.${HOSTNAME_SUFFIX}`;
export const ROOT_HOSTNAME = `desolate.${HOSTNAME_SUFFIX}`;
/** The approval page (host/approve-web.ts), served by the host daemon itself on the editors'
 *  port. A name of its own, not under ROOT_HOSTNAME: the dashboard's content comes from the
 *  root, and a cookie it set for its own domain would be sent to names under it. */
export const APPROVE_HOSTNAME = `desolate-approve.${HOSTNAME_SUFFIX}`;
/** The git terminal (host/git-web.ts): a bash in the git VM, in a browser tab. */
export const GIT_HOSTNAME = `desolate-git.${HOSTNAME_SUFFIX}`;

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

declare namespace isLocalhostSuffix {
  /** localhost, or names under it: never another domain, a port or anything a URL could escape by */
  export type Names = Table<typeof isLocalhostSuffix, [
    [args: [value: "localhost"], expected: true],
    [args: [value: "acme--app-w1-0a1b2c.localhost"], expected: true],
    [args: [value: "example.com"], expected: false],
    [args: [value: "localhost.example.com"], expected: false],
    [args: [value: "a.localhost:80"], expected: false],
    [args: [value: "A.localhost"], expected: false],
    [args: [value: ".localhost"], expected: false],
  ]>;
}
