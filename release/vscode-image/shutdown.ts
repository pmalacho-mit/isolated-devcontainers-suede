/**
 * shutdown.ts -- stopping a devcontainer in an order its own daemon survives.
 *
 * A container stopped mid-build cannot tear its mount namespace down, so its
 * init never reports an exit and the daemon supervising it waits for that exit
 * forever. `shadowBaseImages` avoids that by staying in the foreground; a stop
 * arriving while the PROJECT's own build is running has the same problem and no
 * such protection, and that is the mechanism by which a stop turns into a wedge.
 *
 * So a project that has a daemon of its own is asked to put its containers away
 * first. Every step is best-effort and bounded: a project whose daemon is
 * ALREADY hung must not be able to hang `desolate --stop` too, and stepping
 * over a step that did not finish leaves the stop exactly where it was before
 * any of this existed.
 */
import type { Docker } from "./docker.ts";

/** Where a step that did not finish gets said. */
export type Report = (message: string) => void;

const stepOver = (say: Report, what: string, step: () => number) => {
  if (step() !== 0)
    say(`warning -- ${what} did not stop in time; stopping the container anyway`);
};

const quiesce = (docker: Docker, cid: string, say: Report) => {
  if (!docker.container.hasDockerCli(cid)) return;
  say("the project has a daemon of its own -- quiescing it first");
  stepOver(say, "the project's containers", () =>
    docker.container.stopInnerContainers(cid),
  );
  stepOver(say, "the project's docker daemon", () =>
    docker.container.stopInnerDaemon(cid),
  );
};

/** Stop a devcontainer without wedging the daemon that supervises it. */
export const devcontainer = (docker: Docker, cid: string, say: Report) => {
  quiesce(docker, cid, say);
  return docker.container.stop(cid);
};
