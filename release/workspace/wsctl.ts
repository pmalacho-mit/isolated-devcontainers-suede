// One request to the workspace daemon: stdin is the JSON request, stdout the JSON reply.
import { connect } from "node:net";

let input = "";
for await (const chunk of process.stdin) input += chunk;
const connection = connect("/run/desolate/wsd.sock");
let output = "";
connection.on("connect", () => connection.write(input.trim() + "\n"));
connection.on("data", (chunk) => (output += chunk));
connection.on("end", () => process.stdout.write(output));
connection.on("error", (error) => {
  process.stdout.write(JSON.stringify({ ok: false, error: `the workspace daemon is not answering: ${error.message}` }) + "\n");
});
