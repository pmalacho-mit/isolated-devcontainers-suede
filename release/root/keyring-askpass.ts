// See keyring-askpass (the wrapper) and keyring.ts. Allows a write-key signature only if a
// person's approval for that repository is on file.
import { ask } from "./keyring-client.ts";
import { KEYRING } from "./layout.ts";

const prompt = process.argv[2] ?? "";
const match = /desolate-write:([A-Za-z0-9_][A-Za-z0-9._-]*\/[A-Za-z0-9_][A-Za-z0-9._-]*)/.exec(prompt);
if (!match) {
  console.error("keyring-askpass: the key being used is not one of desolate's write keys; refusing");
  process.exit(1);
}
try {
  const reply = await ask(KEYRING.internal, { op: "consume", repo: match[1] }, 5000);
  process.exit(reply.ok === true ? 0 : 1);
} catch (error) {
  console.error(`keyring-askpass: ${String(error)}; refusing`);
  process.exit(1);
}
