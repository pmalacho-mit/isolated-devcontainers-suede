/**
 * dockerfile-build.ts -- a project that builds from its own Dockerfile is
 * built FIRST, and the spec `up` starts from names the image that came out.
 *
 * The CLI merges a base image's `devcontainer.metadata` label into the
 * container it creates -- privileged, capAdd, securityOpt, mounts, entrypoint
 * may all come from there. For an `image:` project the image exists when the
 * policy reads the spec, so the label is in what it judges (and desolate pins
 * the image by digest). For a Dockerfile project the image does not exist
 * until `up` builds it, so `up` merged a label the policy never saw: measured
 * against @devcontainers/cli 0.88.0, `FROM` a base carrying
 * `[{"privileged":true}]` started privileged behind a spec that passed. (A
 * LABEL in the project's own Dockerfile is replaced by the CLI's and does not
 * apply; a base image's does.)
 *
 * So, once the policy has passed the build's INPUTS (the snapshot's
 * build.context, build.dockerfile, no build.options), the runner runs
 * `devcontainer build`, takes the id of the image it made, and rewrites the
 * spec to `image: <id>` -- no build, no features (they are in the image, and
 * in its label). The policy then reads THAT spec, label merged, and `up`
 * starts that image and no other: an id names content, not a tag anyone can
 * move.
 *
 * `devcontainer build` takes a workspace folder and no config, and reads
 * `.devcontainer/devcontainer.json` under it. Pointed at the project it would
 * build from the live spec -- not the snapshot the policy passed, and a live
 * spec can say `build.options`. So it is pointed at a scratch workspace whose
 * spec is the derived one, with the Dockerfile and the context written as
 * absolute paths: the snapshot's Dockerfile, the project's context.
 */
import { posix } from "node:path";

type Spec = Record<string, unknown>;

const object = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

/** Does this spec build from a Dockerfile (either spelling)? */
export const buildsFromDockerfile = (spec: Spec): boolean =>
  spec.dockerFile !== undefined || object(spec.build)?.dockerfile !== undefined;

/**
 * The spec `devcontainer build` is given, in the scratch workspace: the
 * derived spec with its build paths made absolute -- the Dockerfile under
 * `snapshotDir` (the copy the policy read), the context under `configDir`,
 * the directory the project's own config file is in, which is what the CLI
 * resolves a relative context against. The legacy spellings fold into
 * `build`.
 */
export const buildSpec = (spec: Spec, snapshotDir: string, configDir: string): Spec => {
  const build = { ...(object(spec.build) ?? {}) };
  const dockerfile = typeof build.dockerfile === "string" ? build.dockerfile : typeof spec.dockerFile === "string" ? spec.dockerFile : "Dockerfile";
  const context = typeof build.context === "string" ? build.context : typeof spec.context === "string" ? spec.context : ".";
  const { dockerFile: _dockerFile, context: _context, ...rest } = spec;
  return {
    ...rest,
    build: { ...build, dockerfile: posix.resolve(snapshotDir, dockerfile), context: posix.resolve(configDir, context) },
  };
};

/**
 * The spec `up` starts from: the derived spec with the build gone and the
 * image named by id. Features go too: `devcontainer build` installed them
 * into the image and wrote their metadata into its label, and declared again
 * they would be installed again on top.
 */
export const imageSpec = (spec: Spec, imageId: string): Spec => {
  if (!/^sha256:[0-9a-f]{64}$/.test(imageId)) throw new Error(`not an image id: ${imageId}`);
  const { build: _build, dockerFile: _dockerFile, context: _context, features: _features, ...rest } = spec;
  return { ...rest, image: imageId };
};
