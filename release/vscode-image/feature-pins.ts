/**
 * feature-pins.ts -- every feature a spec declares, pinned to the digest of the
 * content that was checked (audit H2).
 *
 * The CLI reads a feature's metadata -- where "privileged", "capAdd", "mounts",
 * "securityOpt" and "entrypoint" are allowed to come from -- once when desolate
 * resolves the spec for the policy, and AGAIN in `devcontainer up`. A tag
 * (`node:1`) names whatever the registry answers each time, so a registry the
 * author of a hostile devcontainer.json runs can answer the check with nothing
 * and `up` with everything. A digest names one manifest: the CLI hashes the
 * body it gets and compares, and hashes the layer it gets and compares
 * (devContainersSpecCLI.js CQ and BQ, read in 0.88.0), so both reads see the
 * same bytes or fail. Before the check, then, every tag is resolved to its
 * digest -- by the CLI's own resolver, `devcontainer upgrade`, whose lockfile
 * this reads -- and the spec the policy judges, and `up` starts, says digests.
 *
 * What cannot be pinned is refused, with the way out:
 *   - an `https://` tarball: its id is a URL, which carries no digest;
 *   - a legacy GitHub-releases id (`owner/repo/feature`, no registry host):
 *     resolved through the GitHub API, outside any digest;
 *   - a feature that `dependsOn` others: its own manifest is pinned, but the
 *     dependencies it names are fetched by THEIR ids, by tag, at both reads.
 *
 * The lockfile is not what pins. `read-configuration` reads none (measured),
 * and `up` reads the one beside the WORKSPACE's config -- the project's own,
 * which could send even a pinned id to another manifest, since the CLI then
 * fetches the lockfile's digest and verifies against that. `up` runs with
 * --no-lockfile; the digests live in the ids. A project's lockfile is still
 * honoured as a statement of which digest it wants for a tag.
 */
import { nonNullObject } from "./utils.ts";

export interface LockfileEntry {
  version?: string;
  /** `<registry>/<path>@sha256:<hex>` for a registry feature. */
  resolved?: string;
  integrity?: string;
  /** The ids of the features this one declares it depends on. */
  dependsOn?: string[];
}

/** What `devcontainer upgrade` writes: one entry per resolved feature set, the
 *  spec's own and any they depend on, keyed by the id each was asked for by. */
export interface Lockfile {
  features: Record<string, LockfileEntry>;
}

export class FeaturePinError extends Error {}

// A registry reference, as the CLI reads one: a host WITH a dot (the CLI
// treats a first segment without one as a GitHub owner, and falls back to
// releases), a path of at least two segments, then a tag, a digest, or both.
const HOST = String.raw`[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+(?::\d{1,5})?`;
const PATH = String.raw`[a-z0-9]+(?:[._-][a-z0-9]+)*(?:/[a-z0-9]+(?:[._-][a-z0-9]+)*)+`;
const REF = new RegExp(String.raw`^(${HOST})/(${PATH})(?::([A-Za-z0-9_][\w.-]{0,127}))?(?:@(sha256:[0-9a-f]{64}))?$`, "i");

export interface Ref {
  /** As written. */
  name: string;
  host: string;
  path: string;
  tag?: string;
  digest?: string;
}

/** The registry reference an id spells, or undefined when it spells none. */
export const parseRef = (id: string): Ref | undefined => {
  const m = REF.exec(id);
  if (!m) return undefined;
  return {
    name: `${m[1]}/${m[2]}`,
    host: m[1].toLowerCase(),
    path: m[2].toLowerCase(),
    ...(m[3] !== undefined ? { tag: m[3] } : {}),
    ...(m[4] !== undefined ? { digest: m[4].toLowerCase() } : {}),
  };
};

export type Kind = "pinned" | "tag" | "tarball" | "local" | "unknown";

/** What an id is, to the pinning: digest-pinned already, a tag to resolve, or
 *  one of the shapes that cannot be pinned. */
export const classify = (id: string): Kind => {
  if (/^https:\/\//i.test(id)) return "tarball";
  if (/^[.~/]/.test(id)) return "local";
  const ref = parseRef(id);
  if (!ref) return "unknown";
  return ref.digest ? "pinned" : "tag";
};

/** The digest `resolved` names for `ref`, when it names the same feature. */
const digestFor = (resolved: unknown, ref: Ref): string | undefined => {
  if (typeof resolved !== "string") return undefined;
  const it = parseRef(resolved);
  return it?.digest && it.host === ref.host && it.path === ref.path ? it.digest : undefined;
};

const noun = (ids: string[]) => ids.map((id) => `'${id}'`).join(", ");

export interface Pinned {
  /** The same options, under digest-pinned ids, in the declared order. */
  features: Record<string, unknown>;
  /** One line per id that was pinned, for the log. */
  notes: string[];
}

/**
 * `features` with every id pinned to a digest, or a FeaturePinError saying
 * which one cannot be and what to do instead.
 *
 * `resolve` runs the CLI's resolver over the declared features and returns
 * the lockfile it writes; it is run whatever the ids say, because only the
 * resolver sees a pinned feature's dependencies. `own` is the project's
 * lockfile, if it ships one: its digest for an id is taken over the registry's
 * current answer, so a project that pins stays pinned.
 */
export const pinFeatures = (
  features: Record<string, unknown>,
  resolve: (features: Record<string, unknown>) => Lockfile,
  own?: Lockfile,
): Pinned => {
  const ids = Object.keys(features);
  for (const id of ids) {
    switch (classify(id)) {
      case "tarball":
        throw new FeaturePinError(
          `feature '${id}' is an https:// tarball, which desolate cannot pin: a URL names whatever the server answers, and the CLI asks it twice -- once for the check, once in 'devcontainer up'. Publish the feature to a registry (ghcr.io/<owner>/<repo>/<feature>) and reference it there.`,
        );
      case "local":
      case "unknown":
        throw new FeaturePinError(
          `feature '${id}' is not a registry reference desolate can pin to a digest (expected "<registry>/<namespace>/<name>[:<version>]", with a dot in the registry). A GitHub-releases id ("owner/repo/feature") is resolved through the GitHub API, outside any digest: reference the feature from its registry instead.`,
        );
    }
  }
  if (!ids.length) return { features, notes: [] };

  const lock = resolve(features);
  const entries = nonNullObject(lock?.features) ? lock.features : {};
  const declared = new Set(ids);
  for (const [key, entry] of Object.entries(entries)) {
    const deps = Array.isArray(entry?.dependsOn) ? entry.dependsOn.filter((d): d is string => typeof d === "string") : [];
    if (deps.length)
      throw new FeaturePinError(
        `feature '${key}' depends on ${noun(deps)}, which desolate cannot pin: a pinned feature's manifest is fixed, but the dependencies it names are fetched by their own ids, by tag, both for the check and in 'devcontainer up'. Use a feature without "dependsOn", or ask its author to pin its dependencies by digest.`,
      );
    if (!declared.has(key))
      throw new FeaturePinError(
        `the resolver would install '${key}', which devcontainer.json does not declare -- a dependency of one of its features. desolate cannot pin a dependency, so it refuses the feature that brings it: declare only features without "dependsOn".`,
      );
  }

  const pinned: Record<string, unknown> = {};
  const notes: string[] = [];
  for (const id of ids) {
    const ref = parseRef(id)!;
    if (ref.digest) {
      pinned[id] = features[id];
      continue;
    }
    const fromOwn = digestFor(own?.features?.[id]?.resolved, ref);
    const digest = fromOwn ?? digestFor(entries[id]?.resolved, ref);
    if (!digest)
      throw new FeaturePinError(
        `feature '${id}' could not be pinned: the resolver named ${typeof entries[id]?.resolved === "string" ? `'${entries[id]!.resolved}'` : "nothing"} for it`,
      );
    pinned[`${ref.name}@${digest}`] = features[id];
    notes.push(`${id} -> @${digest.slice("sha256:".length, "sha256:".length + 12)}${fromOwn ? " (its lockfile's)" : ""}`);
  }
  return { features: pinned, notes };
};

/** The ids among `features` that carry no digest -- what must not reach `up`. */
export const unpinned = (features: unknown): string[] =>
  typeof features === "object" && features !== null && !Array.isArray(features)
    ? Object.keys(features).filter((id) => classify(id) !== "pinned")
    : [];
