// A stand-in for "a host on the internet", in the forge's container: HTTP on 80 and HTTPS on
// 443 (its own CA, written to the state directory for a test's client to trust). It says
// which name it was asked for and logs every request, so a test can tell what reached it.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import * as path from "node:path";
import { append, STATE } from "./common.ts";

const key = path.join(STATE, "upstream.key");
const cert = path.join(STATE, "upstream.crt");
if (!fs.existsSync(cert))
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "2", "-subj", "/CN=desolate test upstream",
    "-addext", "subjectAltName=DNS:api.example.test,DNS:*.example.test,DNS:other.example.test"], { stdio: "ignore" });
fs.chmodSync(cert, 0o644);
const handler = (scheme: string) => (request: http.IncomingMessage, response: http.ServerResponse) => {
  let body = "";
  request.on("data", (chunk) => (body += chunk));
  request.on("end", () => {
    append("upstream.log", { scheme, host: request.headers.host, path: request.url, authorization: request.headers.authorization ?? null, apiKey: request.headers["x-api-key"] ?? null, body: body.slice(0, 500) });
    // /echo says back what it was sent, as an API that reflects its input would.
    const echo = request.url?.startsWith("/echo") ? ` authorization=${request.headers.authorization ?? ""}` : "";
    if (echo) response.setHeader("x-echo", String(request.headers.authorization ?? ""));
    response.end(`upstream ${scheme} host=${request.headers.host} path=${request.url}${echo}\n`);
  });
};
http.createServer(handler("http")).listen(80, "0.0.0.0");
https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, handler("https")).listen(443, "0.0.0.0");
