/**
 * relays.ts -- naming for the socat containers that carry a host port into a
 * devcontainer.
 *
 * The name is the only place a relay's project and host port are recorded in a
 * form other code reads back, so composing and decomposing it must be one pair
 * of functions rather than a template literal in each caller.
 */
import { volumeNamespace } from "./projects.ts";

const PREFIX = "desolate-relay";
export const IMAGE = "alpine/socat";

export const name = (project: string, hostPort: number) =>
  `${PREFIX}-${volumeNamespace(project)}-${hostPort}`;

/** The host port a relay name encodes, or undefined if it encodes none.
 *
 *  Reading the port back off the name is how an already-running relay's port
 *  is recognised as this project's rather than a stranger's, so a name that
 *  does not end in a port must not silently answer NaN. */
export const hostPort = (name: string): number | undefined => {
  const trailing = name.split("-").pop() ?? "";
  return /^\d+$/.test(trailing) ? Number(trailing) : undefined;
};

/** Matches every relay of one project, and no other container. */
export const label = (project: string) => `desolate.relay=${project}`;
