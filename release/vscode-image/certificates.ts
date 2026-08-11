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
 * @param baseUser the image's own user, restored after the install: the tools
 * above need `USER root`, and leaving it there breaks the devcontainer CLI's
 * assumptions about who the image runs as.
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

/** Where the background shadow job leaves its output, INSIDE the devcontainer.
 *  Named in the line desolate prints at start, because that job outlives the
 *  command that launched it and this is the only place its errors go. */
export const SHADOW_LOG = "/tmp/desolate-shadow-images.log";

/**
 * `customizations.desolate.shadowImages`, applied.
 *
 * The declare-once form of `trust-proxy-in-builds.sh --shadow`: a project names
 * the base images its own builds start from, and each one's tag is pointed at a
 * CA-trusting derivative before anybody builds anything.
 *
 * Three constraints decide the shape of this, and all three are about WHERE it
 * runs. The tag has to land in the devcontainer's INNER daemon -- the one the
 * docker-in-docker feature starts with the container -- which the orchestrator
 * cannot reach from outside, so this is a script executed in there rather than
 * a docker call out here. That daemon starts *with* the container and is not up
 * when we are, hence the wait. And it PULLS images, so it is slow enough that
 * blocking the editor on it would be the wrong trade -- it runs detached, and
 * this log is where it says what happened.
 *
 * Nothing in it is fatal. A project whose base image cannot be shadowed still
 * gets a working container; what it does not get is build-time HTTPS, and the
 * log says so in those words.
 */
const SHADOW_SCRIPT = `
exec >>${SHADOW_LOG} 2>&1
echo "=== shadowing $# base image(s) so that builds FROM them trust the proxy CA"

# Two answers, not one: install-ca.sh has just restarted this daemon, so the
# first 'docker info' that succeeds can be one on its way down.
ready=0
waited=0
while [ "$ready" -lt 2 ]; do
    if [ "$waited" -ge 120 ]; then
        echo "!!! no docker daemon answered in 120s -- nothing was shadowed."
        echo "    shadowImages needs a daemon of this project's own. Add it:"
        echo '      "features": { "ghcr.io/devcontainers/features/docker-in-docker:2": {} }'
        exit 0
    fi
    if docker info >/dev/null 2>&1; then ready=$((ready + 1)); else ready=0; fi
    sleep 2
    waited=$((waited + 2))
done

for image in "$@"; do
    echo "=== $image"
    ${CA_DIR}/trust-proxy-in-builds.sh --image "$image" --shadow ||
        echo "!!! could not shadow $image -- builds FROM it will NOT trust the proxy CA"
done
echo "=== done"
`;

/** The argv to run detached, as root, inside the devcontainer.
 *
 *  The images are ARGUMENTS, never text spliced into the script: they come from
 *  devcontainer.json, this runs as root, and a value that closes a quote would
 *  otherwise be a shell of its own. `$0` is a name for the job, not an image. */
export const shadowImagesCommand = (images: string[]) => [
  "sh",
  "-c",
  SHADOW_SCRIPT,
  "desolate-shadow-images",
  ...images,
];

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
