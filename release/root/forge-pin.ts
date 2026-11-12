// The forge's address and host key, in root's own directory, for the pusher.
//
//   node forge-pin.ts        (as root, by the host, at every bootstrap; the forge on stdin)
//
// The root's user keeps a copy of its own for fetching (ops.ts, `forge.set`), and could
// rewrite it: the pusher, which holds the write key's agent, reads this one instead, so the
// root's user cannot aim a push at a host of its choosing. Written by root, 0644, by rename.
import * as fs from "node:fs";
import { PINNED_FORGE } from "./layout.ts";

const main = async () => {
  if (process.getuid!() !== 0) throw new Error("forge-pin.ts runs as root, from the host's own way in");
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  const forge = JSON.parse(text) as { kind?: string; ssh?: { user?: string; host?: string; port?: number }; knownHosts?: string };
  const ssh = forge.ssh ?? {};
  if ((forge.kind !== "github" && forge.kind !== "stand-in") || !/^[a-z_][a-z0-9_-]*$/.test(ssh.user ?? "") || !/^[A-Za-z0-9.-]+$/.test(ssh.host ?? "") || !Number.isInteger(ssh.port) || ssh.port! < 1 || ssh.port! > 65535)
    throw new Error("the forge is {kind, ssh:{user,host,port}, knownHosts}");
  const known = String(forge.knownHosts ?? "").split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
  if (known.length === 0 || known.some((line) => /[^\x20-\x7e]/.test(line) || line.split(/\s+/).length < 3)) throw new Error("the forge's host keys are known_hosts lines");
  const put = (file: string, content: string) => {
    const temp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(temp, content, { mode: 0o644 });
    fs.chownSync(temp, 0, 0);
    fs.chmodSync(temp, 0o644);
    fs.renameSync(temp, file);
  };
  put(PINNED_FORGE.config, JSON.stringify({ kind: forge.kind, ssh: { user: ssh.user, host: ssh.host, port: ssh.port } }, null, 2) + "\n");
  put(PINNED_FORGE.knownHosts, known.join("\n") + "\n");
  process.stdout.write(JSON.stringify({ ok: true }) + "\n");
};

main().catch((error: Error) => {
  process.stdout.write(JSON.stringify({ ok: false, error: error.message }) + "\n");
  process.exit(1);
});
