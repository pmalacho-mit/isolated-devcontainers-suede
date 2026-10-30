import { nonNullObject, run, type JSONValue } from "./utils.ts";
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface ResolvedSpec {
  /**
   * The raw devcontainer.json, parsed by the devcontainer CLI.
   *
   * Effectively what the user authored (so excludes any contributions from features)
   */
  configuration: { [key: string]: JSONValue };
  /**
   * The project's config with every feature's metadata merged in
   * (via `read-configuration --include-merged-configuration` from the devcontainer CLI).
   * This is where feature-injected privileged/capAdd/securityOpt/mounts show up, and
   * enforcing on it is what makes feature escapes impossible.
   */
  mergedConfiguration: { [key: string]: JSONValue };
}

/**
 * Ask the CLI to resolve the config, features merged.
 * @param workspace path to project folder (the "workspace")
 * @param config path to config file
 * (likely not within the project folder in the case of config "snapshots")
 * @returns resolved spec
 * @throws if the devcontainer CLI errors out, or if cannot retrieve both
 * `ResolvedSpec.configuration` and `ResolvedSpec.mergedConfiguration`
 */
/** Why `read-configuration` failed, from what execFileSync threw. A timeout
 *  leaves only what the CLI printed before it was killed -- its version
 *  banner, often -- so it is named as a timeout rather than quoted as an error. */
export const describeResolveFailure = (err: any, timeoutMs: number) => {
  /** How much of a failed CLI invocation's output to quote back to the caller */
  const tailChars = 400;
  const timedOut = err?.code === "ETIMEDOUT" || err?.signal === "SIGTERM";
  const detail = String(err?.stderr || err?.stdout || err?.message || err).trim().slice(-tailChars);
  return `could not resolve devcontainer.json (refusing to start)${
    timedOut ? `: it did not finish in ${timeoutMs / 1000}s (resolving features fetches them; try again)` : ""
  }: ${detail}`;
};

/**
 * The label `read-configuration` is told to find this workspace's container
 * by, and that no container carries. Without it the CLI looks the container up
 * by the workspace's own labels and, if one exists -- stopped ones included --
 * takes `mergedConfiguration` from THAT container's image metadata instead of
 * resolving the spec: a container built when the spec said docker-in-docker
 * answered "privileged" for ever, and the broker refused a clean spec (#26).
 * With it, every caller judges the spec as it is declared; an existing
 * container is compared against that separately (policy.ts builtBeyondDeclared).
 * Measured on @devcontainers/cli 0.88.0: honoured, features still resolved.
 */
export const RESOLVE_ID_LABEL = "desolate.resolve=spec";

/**
 * The user a devcontainer's tools run as, from the `devcontainer.metadata`
 * label the CLI stamped it with: the LAST entry naming a `remoteUser` wins
 * (the spec's own entry comes after its features'), then `containerUser`.
 * undefined when neither is named -- the image's own user, then.
 */
export const remoteUserOf = (metadataLabel: string): string | undefined => {
  let entries: unknown;
  try {
    entries = JSON.parse(metadataLabel);
  } catch {
    return undefined;
  }
  const list = (Array.isArray(entries) ? entries : [entries]).filter(
    (entry): entry is Record<string, unknown> => entry !== null && typeof entry === "object");
  const named = (key: string) =>
    [...list].reverse().map((entry) => entry[key]).find((value): value is string =>
      typeof value === "string" && /^[A-Za-z0-9._-][A-Za-z0-9._@-]{0,63}$/.test(value));
  return named("remoteUser") ?? named("containerUser");
};

export const resolveSpec = (
  workspace: string,
  config: string,
): ResolvedSpec => {
  let stdout: string;
  /** Generous: resolving features is a NETWORK operation. */
  const timeoutMs = 120000;
  try {
    stdout = run(
      "devcontainer",
      [
        "read-configuration",
        "--include-merged-configuration",
        "--workspace-folder",
        workspace,
        "--override-config",
        config,
        "--id-label",
        RESOLVE_ID_LABEL,
      ],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: timeoutMs,
      },
    );
  } catch (err: any) {
    throw new Error(describeResolveFailure(err, timeoutMs));
  }

  // The CLI interleaves progress lines with its JSON result, so take the LAST
  // line that parses and carries both keys.
  for (const line of stdout.split("\n").reverse()) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (
        nonNullObject(parsed?.configuration) &&
        nonNullObject(parsed?.mergedConfiguration)
      )
        return parsed;
    } /* not the result line */ catch {}
  }

  throw new Error(
    [
      "devcontainer read-configuration produced no result carrying BOTH",
      "configuration and mergedConfiguration (refusing to start). The merged view",
      "is where a feature's privileged/capAdd/mounts appear, so without it the",
      "policy cannot see what this spec actually asks for.",
    ].join(" "),
  );
};

export const tryLocateConfig = (dir: string) => {
  const nested = join(dir, ".devcontainer", "devcontainer.json");
  const flat = join(dir, ".devcontainer.json");
  return existsSync(nested) ? nested : existsSync(flat) ? flat : undefined;
};

/**
 * The config path the CLI STAMPS on a container it creates -- which is not the
 * one we told it to read.
 *
 * `--override-config` changes which JSON is parsed and nothing else. The
 * `devcontainer.config_file` label still names the config inside the WORKSPACE
 * FOLDER, the same place `build.context` resolves against. Measured on
 * @devcontainers/cli 0.88.0 against a real container:
 *
 *   devcontainer up --workspace-folder <ws>/proj \
 *                   --override-config <specs>/proj/devcontainer.json
 *   -> devcontainer.config_file=<ws>/proj/.devcontainer/devcontainer.json
 *
 * So this, not the path we passed, is the half of a container's identity that
 * docker.ts's lookup insists on (see selectWorkspaceContainer). Handing that
 * lookup the override path matches nothing, and the symptom is a container that
 * starts normally and then cannot be found -- "devcontainer is not running
 * after up", about a container `docker ps` is showing.
 *
 * Empty when the project has no config at all, which is what `desolate --stop`
 * on a project whose devcontainer.json was deleted depends on: no config known,
 * so the lookup falls back to matching the workspace alone.
 */
export const labelledConfig = (dir: string) => tryLocateConfig(dir) ?? "";

/**
 * Does this directory carry a devcontainer spec, in either of the two layouts
 * the CLI accepts?
 *
 * Existence only.
 */
export const hasConfig = (dir: string): boolean =>
  tryLocateConfig(dir) !== undefined;
