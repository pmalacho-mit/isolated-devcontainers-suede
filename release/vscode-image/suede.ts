/**
 * suede.ts -- `cli.sh suede`'s half in the editor, where the keys and caches are
 * (transfer.ts deliver, pushUpstream). Not on the editor's PATH and not in its
 * panel: cli.sh runs it by path. docs/suede-factory.md.
 *
 *   suede.ts deliver  <project> <owner/repo>
 *   suede.ts upstream <project> <owner/repo> <bundle name> <commit> <pin> <consumer commit>
 */
import { deliver, pushUpstream, TransferError } from "./transfer.ts";
import { TRANSFER_NAME } from "./args.ts";

const [command, ...rest] = process.argv.slice(2);
try {
  if (command === "deliver" && rest.length === 2) {
    console.log(`suede: ${deliver(rest[0], rest[1])}`);
  } else if (command === "upstream" && rest.length === 6 && TRANSFER_NAME.test(rest[2])) {
    const [project, ownerRepo, name, commit, pin, consumerCommit] = rest;
    console.log(`UPSTREAMED ${pushUpstream(project, ownerRepo, { name, commit, pin, consumerCommit })}`);
  } else {
    console.error("usage: suede.ts deliver <project> <owner/repo>\n       suede.ts upstream <project> <owner/repo> <bundle name> <commit> <pin> <consumer commit>");
    process.exit(2);
  }
} catch (err) {
  if (!(err instanceof TransferError)) throw err;
  console.error(`suede: ${err.message}`);
  process.exit(1);
}
