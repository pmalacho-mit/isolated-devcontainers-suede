// A Git LFS server, enough of one for git-lfs to talk to: the batch API, the
// basic transfer adapter, and verify. It wants `Authorization` on the batch
// call -- as GitHub's does, with the token git-lfs-authenticate gave -- and
// says who asked for what, so a test can tell where a token went.
import { createServer, type IncomingMessage, type Server } from "node:http";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";

export interface Seen { method: string; path: string; authorization?: string }

export interface LfsServer {
  /** `http://127.0.0.1:<port>/<repo>`: what git-lfs-authenticate's href is. */
  url: string;
  token: string;
  objects: Map<string, Buffer>;
  seen: Seen[];
  close: () => Promise<void>;
}

const body = (request: IncomingMessage) =>
  new Promise<Buffer>((resolve) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(chunk)).on("end", () => resolve(Buffer.concat(chunks)));
  });

export async function lfsServer(repo = "acme/widgets", token = "RemoteAuth test-token"): Promise<LfsServer> {
  const objects = new Map<string, Buffer>();
  const seen: Seen[] = [];
  let origin = "";
  const server: Server = createServer(async (request, response) => {
    const path = request.url ?? "";
    const authorization = request.headers.authorization;
    seen.push({ method: request.method ?? "", path, ...(authorization ? { authorization } : {}) });
    const send = (status: number, json?: unknown) => {
      response.writeHead(status, { "Content-Type": "application/vnd.git-lfs+json" });
      response.end(json === undefined ? "" : JSON.stringify(json));
    };
    const data = await body(request);
    const batch = `/${repo}/objects/batch`;
    if (request.method === "POST" && path === batch) {
      if (authorization !== token) return send(401, { message: "Credentials needed" });
      const asked = JSON.parse(data.toString());
      const answer = (asked.objects as { oid: string; size: number }[]).map(({ oid, size }) => {
        const have = objects.get(oid);
        if (asked.operation === "upload")
          return have
            ? { oid, size }
            : { oid, size, actions: {
                upload: { href: `${origin}/storage/${oid}`, header: { "X-Action": "upload" } },
                verify: { href: `${origin}/verify`, header: { "X-Action": "verify" } },
              } };
        return have
          ? { oid, size, actions: { download: { href: `${origin}/storage/${oid}`, header: { "X-Action": "download" } } } }
          : { oid, size, error: { code: 404, message: "Object does not exist" } };
      });
      return send(200, { transfer: "basic", objects: answer });
    }
    const object = /^\/storage\/([0-9a-f]{64})$/.exec(path)?.[1];
    if (request.method === "PUT" && object) {
      if (!request.headers["x-action"]) return send(403);
      if (createHash("sha256").update(data).digest("hex") !== object) return send(422, { message: "oid mismatch" });
      objects.set(object, data);
      return send(200);
    }
    if (request.method === "GET" && object) {
      const have = objects.get(object);
      if (!have || !request.headers["x-action"]) return send(404);
      response.writeHead(200, { "Content-Type": "application/octet-stream" });
      return response.end(have);
    }
    if (request.method === "POST" && path === "/verify") return send(objects.has(JSON.parse(data.toString()).oid) ? 200 : 404);
    return send(404, { message: "no such thing" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url: `${origin}/${repo}`,
    token,
    objects,
    seen,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
