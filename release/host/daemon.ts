// The host daemon: the forwarder (ports, routed by name) and each workspace's link to its
// proxy. PLACEHOLDER until the forwarder lands.
import type { WorkspacePlan } from "../shared/plan.ts";
export const stopForwarder = async () => {};
export const connectWorkspace = async (_plan: WorkspacePlan) => {};
export const disconnectWorkspace = async (_vm: string) => {};
