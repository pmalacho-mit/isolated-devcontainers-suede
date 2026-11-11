// The forge's LFS server: the batch API and the basic transfer adapter, authorised by the
// token git-lfs-authenticate handed out.
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { createServer } from "node:http";
import * as path from "node:path";
import { append, checkToken, config, lfsDir } from "./common.ts";

const OID = /^[0-9a-f]{64}$/;
const objectPath = (repo: string, oid: string) => path.join(lfsDir(repo), oid.slice(0, 2), oid.slice(2, 4), oid);

const server = createServer((request, response) => {
  const send = (status: number, body: unknown, type = "application/vnd.git-lfs+json") => {
    response.writeHead(status, { "Content-Type": type });
    response.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  };
  const url = new URL(request.url ?? "/", "http://forge");
  const token = checkToken((request.headers.authorization ?? "").replace(/^Bearer /, ""));
  const batch = /^\/(.+?)\.git\/info\/lfs\/objects\/batch$/.exec(url.pathname);
  const object = /^\/(.+?)\.git\/lfs\/objects\/([0-9a-f]{64})$/.exec(url.pathname);
  const repo = batch?.[1] ?? object?.[1] ?? "";
  if (!token || token.repo !== repo) return send(401, { message: "this token is not for this repository" });

  if (batch && request.method === "POST") {
    let text = "";
    request.on("data", (chunk) => (text += chunk));
    request.on("end", () => {
      const body = JSON.parse(text) as { operation: string; objects: { oid: string; size: number }[] };
      if (body.operation === "upload" && token.operation !== "upload") {
        append("access.log", { lfs: "batch", repo, operation: body.operation, verdict: "denied" });
        return send(403, { message: "this key is read-only; it cannot upload LFS objects" });
      }
      const { host, lfsPort } = config();
      const href = (oid: string) => `http://${host}:${lfsPort}/${repo}.git/lfs/objects/${oid}`;
      const header = { Authorization: request.headers.authorization! };
      const objects = body.objects.map(({ oid, size }) => {
        if (!OID.test(oid)) return { oid, size, error: { code: 422, message: "bad oid" } };
        const have = fs.existsSync(objectPath(repo, oid));
        if (body.operation === "download")
          return have ? { oid, size, actions: { download: { href: href(oid), header } } } : { oid, size, error: { code: 404, message: "object not found" } };
        return have ? { oid, size } : { oid, size, actions: { upload: { href: href(oid), header } } };
      });
      append("access.log", { lfs: "batch", repo, operation: body.operation, objects: body.objects.length, verdict: "allowed" });
      send(200, { transfer: "basic", objects });
    });
    return;
  }
  if (object && request.method === "GET") {
    const file = objectPath(repo, object[2]!);
    if (!fs.existsSync(file)) return send(404, { message: "object not found" });
    return send(200, fs.readFileSync(file), "application/octet-stream");
  }
  if (object && request.method === "PUT") {
    if (token.operation !== "upload") return send(403, { message: "this key is read-only" });
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const data = Buffer.concat(chunks);
      if (createHash("sha256").update(data).digest("hex") !== object[2]) return send(422, { message: "content does not match its oid" });
      const file = objectPath(repo, object[2]!);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, data);
      append("access.log", { lfs: "upload", repo, oid: object[2], size: data.length });
      send(200, "", "text/plain");
    });
    return;
  }
  send(404, { message: "not found" });
});
server.listen(Number(process.env.FORGE_LFS_PORT ?? 8080), "0.0.0.0");
