/**
 * relays.ts -- naming for the socat containers that carry a host port into a
 * devcontainer.
 *
 * The name is the only place a relay's project and host port are recorded in a
 * form other code reads back, so composing and decomposing it must be one pair
 * of functions rather than a template literal in each caller.
 */
import type { Target } from "./projects.ts";

const PREFIX = "desolate-relay";
export const IMAGE = "alpine/socat";

export const name = ({ namespace }: Target, hostPort: number) =>
  `${PREFIX}-${namespace}-${hostPort}`;

/** The host port a relay name encodes, or undefined if it encodes none.
 *
 *  Reading the port back off the name is how an already-running relay's port
 *  is recognised as this project's rather than a stranger's, so a name that
 *  does not end in a port must not silently answer NaN. */
export const hostPort = (name: string): number | undefined => {
  const trailing = name.split("-").pop() ?? "";
  return /^\d+$/.test(trailing) ? Number(trailing) : undefined;
};

/** Matches every relay of one target, and no other container.
 *
 *  The label value is the target's WRITTEN name, not its namespace: label
 *  values are unconstrained, and `acme/widgets@feature123` is what the user
 *  would type to stop it. */
export const label = (target: Target) => `desolate.relay=${target.name}`;
