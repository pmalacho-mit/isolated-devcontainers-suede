import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Docker } from "./docker.ts";
import { CA_DIR } from "./overlay.ts";

const CA_IMAGE_REPO = "desolate-ca/base";

/**
 * Both cert locations are populated so one Dockerfile covers
 * Debian/Ubuntu/Alpine (update-ca-certificates) and RHEL-family (update-ca-trust).
 * Missing BOTH tools is a hard failure, not a silent skip -- a base image we cannot
 * teach to trust the proxy cannot build anything over HTTPS, and saying so
 * here is far cheaper than an x509 error deep in a Feature install.
 * @param baseUser certificates must be installed using root user (e.g. `USER root`),
 * so we must switch back to `baseUser` after completing the install (e.g. `USER <baseUser>`)
 * @returns
 */
export const installInstructions = <T extends string>(baseUser: T) =>
  `USER root
COPY ca.pem /usr/local/share/ca-certificates/desolate-proxy.crt
COPY ca.pem /etc/pki/ca-trust/source/anchors/desolate-proxy.crt
RUN set -eu; \\
    if command -v update-ca-certificates >/dev/null 2>&1; then update-ca-certificates; \\
    elif command -v update-ca-trust >/dev/null 2>&1; then update-ca-trust extract; \\
    else echo 'desolate: this base image has neither update-ca-certificates nor update-ca-trust;' >&2; \\
         echo '          install the ca-certificates package in it to build behind the proxy.' >&2; \\
         exit 1; fi
ENV SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt
ENV REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt
ENV CARGO_HTTP_CAINFO=/etc/ssl/certs/ca-certificates.crt
ENV GIT_SSL_CAINFO=/etc/ssl/certs/ca-certificates.crt
ENV NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/desolate-proxy.crt
USER ${baseUser}
` as const;

/** Build (once) an image identical to `baseImage` but trusting the proxy CA.
 *  Returns its tag, or "" if it could not be produced. */
export function caTrustingImage(baseImage: string, docker: Docker): string {
  const caPem = readFileSync(`${CA_DIR}/ca.pem`, "utf8");
  // Keyed on base AND CA: regenerating the CA must not silently reuse an image
  // that trusts the old one.
  const digest = createHash("sha256")
    .update(`${baseImage}\0${caPem}`)
    .digest("hex")
    .slice(0, 16);
  const tag = `${CA_IMAGE_REPO}:${digest}`;

  if (docker.image.id(tag)) return tag;

  console.log(`desolate: deriving a CA-trusting image from ${baseImage}`);
  console.log(`          (once per base image; cached as ${tag})`);

  // The base must be local before we can read its USER.
  if (!docker.image.id(baseImage))
    if (docker.image.pull(baseImage) !== 0) {
      console.error(
        `desolate: warning -- could not pull ${baseImage} to derive a CA image`,
      );
      return "";
    }

  const dockerfile = `FROM ${baseImage}\n${installInstructions(docker.image.user(baseImage))}`;

  const built = docker.image.build(tag, dockerfile, CA_DIR);
  if (built.ok) return tag;

  console.error(
    `desolate: warning -- could not derive a CA-trusting image from ${baseImage}:`,
  );
  console.error(built.output.split("\n").slice(-8).join("\n"));
  return "";
}
