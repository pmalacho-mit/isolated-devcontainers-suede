// A domain's template (move-to-vms.md section 4.7, C3): its environment built once, and every
// later workspace of the domain a copy-on-write clone of that disk instead of desolate's base.
//
// WHAT IT IS. A stopped VM whose disk has the domain's devcontainer images built (the spec's
// image pulled, its Dockerfile and features built) and its editor's extensions installed.
// A new workspace boots a clone of it; `devcontainer up` there finds the images and makes
// the workspace's own container from them in a second (measured in Phase 0: 11.0 s from
// clone to a running devcontainer, against minutes to build).
//
// WHO MAKES IT, AND WHY THAT IS SAFE. The template is the domain's code's output, so it is
// the domain's and nobody else's: it is built in a VM exactly like the domain's workspaces
// (no network but its own proxy, the domain's shares only, the domain's rules and secrets),
// by the domain's own spec, and only that domain's workspaces are ever cloned from it.
// Nothing of it reaches the root, the host or another domain (the rule in section 4.7: a
// cache a domain writes is shared within that domain only). A template is no more trusted
// than a workspace of its domain, and is given to nothing that trusts it more.
//
// WHAT IS KEYED. The spec as the remote published it (the root's git names it by the id of
// `.devcontainer/` or `.devcontainer.json` on the environment repository's default branch,
// in the mirror) and what made the VM it was built in (the image's provisioning, its pins,
// the code that runs the devcontainer). Any change, and the next `up` builds a new one. A
// workspace whose own checkout has another spec gets that spec built in its clone: right,
// just not faster.
//
// WHAT IS NOT CARRIED. Whatever is one workspace's: its editor's connection token (each
// clone makes its own, so no two editors share one), who it is, its logs, its containers.
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { WorkspacePlan } from "../shared/plan.ts";
import { INSTANCE, RELEASE_DIR } from "./paths.ts";
import { backend, rootctl } from "./stack.ts";
import type { VmSpec } from "./vm/types.ts";

type EnvKey = { repo: string; spec: string; id: string };
export type Builder = {
  specOf: (plan: WorkspacePlan, repos: string[]) => VmSpec;
  startServices: (plan: WorkspacePlan) => Promise<{ devcontainer: string; editorDown: string | null }>;
};

const hashOf = (...parts: string[]) => createHash("sha256").update(parts.join("\n")).digest("hex");
const released = (file: string) => {
  try {
    return hashOf(fs.readFileSync(path.join(RELEASE_DIR, file), "utf8"));
  } catch {
    return "missing";
  }
};
/** The template's key: the spec, and what the VM it is built in is made of. */
export const keyOf = (env: EnvKey) =>
  hashOf(env.repo, env.spec, env.id, released("image/provision.sh"), released("pins.env"), released("workspace/devcontainer.ts"), released("workspace/editor.sh")).slice(0, 16);
/** `dsl-<instance>-t<9 hex>`: as long as a workspace's VM name (the socket-path check counts
 *  on it), and never one ("t" is not hex). */
export const templateVm = (domain: string, key: string) => `dsl-${INSTANCE}-t${hashOf(domain, key).slice(0, 9)}`;

/** Run as root in the template before it is stopped: what is one workspace's goes. */
const SCRUB = `set -e
docker ps -aq 2>/dev/null | xargs -r docker rm -f >/dev/null 2>&1 || true
for home in /home/*; do
  rm -f "$home/.desolate-editor/token" "$home/.desolate-editor/gate.host" "$home/.desolate-editor/gate.pid" "$home/.desolate-editor/server.pid" "$home/.desolate/workspace.json"
done
rm -f /var/lib/desolate/*.log
sync`;

/** The domain's template for its environment as published now: present, or built now.
 *  null when the domain has no spec, or the build did not come up (the workspace is then made
 *  from desolate's base, as before, and `say` says why). */
export const ensure = async (domain: string, repos: string[], build: Builder, say: (line: string) => void): Promise<string | null> => {
  // A template only makes a start faster: nothing about one may stop a workspace being made
  // (two `up`s at once in a domain: the second finds the first's build under way).
  try {
    return await ensureOrThrow(domain, repos, build, say);
  } catch (error) {
    say(`  no template: ${(error as Error).message.replace(/[\x00-\x1f\x7f-\x9f]/g, "?").slice(0, 300)}. This workspace is made from desolate's base.`);
    return null;
  }
};

const ensureOrThrow = async (domain: string, repos: string[], build: Builder, say: (line: string) => void): Promise<string | null> => {
  const b = backend();
  const env = await rootctl<EnvKey | null>("domain.env-key", { slug: domain }, { quiet: true });
  if (!env) return null;
  const key = keyOf(env);
  const name = templateVm(domain, key);
  const info = await b.info(name);
  if (info.status === "stopped" && info.labels.template === key && info.labels.domain === domain) return name;
  // A template of this domain for another environment is stale; one half made is no use.
  for (const vm of await b.list())
    if (vm.labels.domain === domain && vm.labels.template && vm.name !== name) await b.destroy(vm.name);
  if (info.status !== "missing") await b.destroy(name);

  say(`  building ${domain}'s environment once (${env.repo}, ${env.spec} ${env.id.slice(0, 12)}): later workspaces start from it`);
  const plan = await rootctl<WorkspacePlan>("workspace.plan", { instance: INSTANCE, domain, name: "template", checkouts: [], base: null, fetch: false }, { quiet: true });
  const builder: WorkspacePlan = { ...plan, vm: name };
  const spec: VmSpec = { ...build.specOf(builder, repos), labels: { title: `${domain} template`, domain, template: key } };
  const { disconnectWorkspace } = await import("./daemon.ts");
  let made = false;
  try {
    await b.create(spec);
    await b.start(name);
    const { devcontainer } = await build.startServices(builder);
    if (!devcontainer.startsWith("up")) throw new Error(`its devcontainer did not come up: ${devcontainer}`);
    const scrubbed = await b.exec(name, ["bash", "-c", SCRUB], { root: true, timeoutMs: 120_000 });
    if (scrubbed.code !== 0) throw new Error(`it could not be emptied of what was the builder's: ${scrubbed.stderr.trim().slice(-200)}`);
    made = true;
  } catch (error) {
    say(`  no template: ${(error as Error).message.replace(/[\x00-\x1f\x7f-\x9f]/g, "?").slice(0, 300)}. This workspace is made from desolate's base.`);
  } finally {
    await disconnectWorkspace(name).catch(() => {});
    await rootctl("proxy.stop", { vm: name }, { quiet: true }).catch(() => {});
    await rootctl("workspace.remove", { domain, name: "template" }, { quiet: true }).catch(() => {});
    if (made) await b.stop(name).catch(() => {});
    else await b.destroy(name).catch(() => {});
  }
  return made && (await b.info(name)).status === "stopped" ? name : null;
};

/** Every template a domain has (when the domain is removed). */
export const removeAll = async (domain: string) => {
  const b = backend();
  for (const vm of await b.list()) if (vm.labels.domain === domain && vm.labels.template) await b.destroy(vm.name);
};
