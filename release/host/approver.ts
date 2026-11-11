// The approver: the one thing that can approve a push, and it is on the host, outside every
// VM (P2, P5). It holds a signing key; the root's keyring files an approval only for a
// challenge this key signed (root/keyring.ts, shared/approval.ts).
//
// Two kinds, chosen once at bootstrap and recorded:
//   touchid   (the default on macOS) the key is in the Secure Enclave and signs only with
//             the person present: Touch ID, or the login password. A program running as
//             you on the Mac, an agent harness included, cannot make it sign.
//   terminal  (Linux, and the tests) a software key in ~/.desolate/approver, mode 0600. It
//             signs after the branch name is typed on this process's controlling terminal.
//             What this does not stop: a program running as you ON THE HOST, which can
//             read the key file or fabricate a terminal. It does stop everything in the
//             VMs, which is what moved: before, the prompt was inside the root VM.
import { spawnSync } from "node:child_process";
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign as signWith, verify } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseApproval } from "../shared/approval.ts";
import { EXIT, Refusal, refuse } from "../shared/exit.ts";
import { paths, RELEASE_DIR } from "./paths.ts";

export type Kind = "touchid" | "terminal";
const DIR = path.join(paths.home, "approver");
const FILES = { kind: path.join(DIR, "kind"), pub: path.join(DIR, "approver.pub"), key: path.join(DIR, "key"), helper: path.join(DIR, "desolate-touchid") } as const;

export const kind = (): Kind | null => {
  try {
    const value = fs.readFileSync(FILES.kind, "utf8").trim();
    return value === "touchid" || value === "terminal" ? value : null;
  } catch {
    return null;
  }
};
export const publicKey = (): string | null => {
  try {
    return createPublicKey(fs.readFileSync(FILES.pub, "utf8")).export({ type: "spki", format: "pem" }).toString();
  } catch {
    return null;
  }
};
export const fingerprint = (pem: string) => createHash("sha256").update(pem).digest("hex");

/** Make the approver if there is none. Returns whether it made one. Which kind: the
 *  DESOLATE_APPROVER environment variable, else touchid on macOS and terminal elsewhere.
 *  On a Mac the weaker kind is never a silent fallback: if Touch ID cannot be set up,
 *  this refuses and says how to choose `terminal` on purpose (P6). */
export const init = (log: (line: string) => void): boolean => {
  if (kind() && publicKey()) return false;
  const asked = process.env.DESOLATE_APPROVER;
  if (asked !== undefined && asked !== "touchid" && asked !== "terminal") refuse(`DESOLATE_APPROVER is '${asked}'`, "use touchid or terminal");
  const chosen: Kind = (asked as Kind | undefined) ?? (process.platform === "darwin" ? "touchid" : "terminal");
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  fs.chmodSync(DIR, 0o700);
  if (chosen === "touchid") {
    const weaker = "to use the weaker terminal approver on purpose: DESOLATE_APPROVER=terminal desolate bootstrap";
    if (process.platform !== "darwin") refuse("the touchid approver needs a Mac", "DESOLATE_APPROVER=terminal");
    const built = spawnSync("swiftc", ["-O", "-o", FILES.helper, path.join(RELEASE_DIR, "host", "approver", "touchid.swift")], { encoding: "utf8" });
    if (built.status !== 0) refuse(`the Touch ID approver did not compile: ${(built.stderr || String(built.error ?? "")).trim().split("\n").slice(-3).join(" | ")}`, `install the Xcode command line tools (xcode-select --install) and bootstrap again; ${weaker}`);
    const made = spawnSync(FILES.helper, ["init", FILES.key], { encoding: "utf8" });
    if (made.status !== 0 || !made.stdout.includes("BEGIN PUBLIC KEY")) refuse(`the Secure Enclave did not make a key: ${made.stderr.trim()}`, weaker);
    fs.writeFileSync(FILES.pub, made.stdout, { mode: 0o644 });
    log("approver: a Secure Enclave key; every push will ask for Touch ID (or your login password)");
  } else {
    const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    fs.writeFileSync(FILES.key, pair.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
    fs.writeFileSync(FILES.pub, pair.publicKey.export({ type: "spki", format: "pem" }), { mode: 0o644 });
    log(`approver: a software key in ${DIR}; every push will ask on your terminal${process.platform === "darwin" ? " (weaker than Touch ID: a program running as you can read this key)" : ""}`);
  }
  fs.writeFileSync(FILES.kind, `${chosen}\n`, { mode: 0o644 });
  return true;
};

const clean = (text: string) => text.replace(/[^\x20-\x7e]/g, "?").slice(0, 300);

/** Ask the person, and sign the keyring's challenge if they say yes. Everything shown is
 *  read out of the very text that gets signed. Refuses (exit 78) on anything else. */
export const sign = async (message: string, summary?: string): Promise<string> => {
  const push = parseApproval(message);
  const which = kind();
  if (!push) throw new Refusal("the root sent something that is not a push approval; nothing was signed", "desolate doctor", EXIT.unconfirmed);
  if (!which) throw new Refusal("this stack has no approver, so no push can be approved", "desolate bootstrap", EXIT.unconfirmed);
  const shown = ["", "desolate: this push needs your confirmation.", `  repository  ${push.repo}`, `  branch      ${push.branch}`, `  commit      ${push.commit}`, ...(summary ? [`  sends       ${clean(summary)}`] : []), ""];
  const unconfirmed = (why: string, fix: string) => new Refusal(`${why}\ndesolate: no person confirmed the push, so nothing was pushed`, fix, EXIT.unconfirmed);

  if (which === "touchid") {
    process.stderr.write(shown.join("\n") + "\nConfirm with Touch ID (or your login password) in the dialog macOS is showing.\n");
    const reason = `approve pushing ${push.branch} of ${push.repo} at ${push.commit.slice(0, 12)}`;
    const signed = spawnSync(FILES.helper, ["sign", FILES.key, reason], { input: message, encoding: "utf8", timeout: 120_000 });
    if (signed.status !== 0 || !signed.stdout.trim()) throw unconfirmed(`the Touch ID prompt was not confirmed${signed.stderr ? ` (${signed.stderr.trim()})` : ""}`, "run the push again and confirm it");
    return signed.stdout.trim();
  }

  // The terminal is this process's CONTROLLING terminal, opened by name: not stdin, which
  // a caller could point anywhere.
  let tty: number;
  try {
    tty = fs.openSync("/dev/tty", "r+");
  } catch {
    throw unconfirmed("a push needs a person's confirmation, and there is no terminal to ask on", "run it from a terminal of your own, on the host");
  }
  fs.writeSync(tty, [...shown, `Type the branch name (${push.branch}) to push, or anything else to refuse: `].join("\n"));
  const answer = await new Promise<string>((resolve) => {
    let text = "";
    const input = fs.createReadStream("", { fd: tty, autoClose: false });
    input.on("data", (chunk) => {
      text += chunk.toString();
      const end = text.indexOf("\n");
      if (end >= 0) {
        input.destroy();
        resolve(text.slice(0, end).trim());
      }
    });
    input.on("end", () => resolve(text.trim()));
    input.on("error", () => resolve(""));
  });
  if (answer !== push.branch) throw unconfirmed("not confirmed", "run the push again, and type the branch name when it asks");
  return signWith("sha256", Buffer.from(message), createPrivateKey(fs.readFileSync(FILES.key, "utf8"))).toString("base64");
};

/** `desolate approve --selftest`: one signature over a text that approves nothing, checked
 *  against the public key the root was given. Proves the person can approve before the
 *  first real push needs it. */
export const selftest = async (out: (line: string) => void): Promise<number> => {
  const message = ["desolate push approval v1", "repo: desolate/selftest", "branch: selftest", `commit: ${"0".repeat(40)}`, `nonce: ${"0".repeat(32)}`, ""].join("\n");
  const signature = await sign(message, "nothing: this is the approver's self-test");
  const pem = publicKey();
  const ok = pem !== null && verify("sha256", Buffer.from(message), createPublicKey(pem), Buffer.from(signature, "base64"));
  out(ok ? `approver (${kind()}): the signature verifies against ${FILES.pub}` : "approver: THE SIGNATURE DID NOT VERIFY against the recorded public key");
  return ok ? 0 : 1;
};
