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

/** Both waits below are for a daemon somebody has already been told to start,
 *  not open-ended polling for one that may never exist -- so the budget is
 *  small, and running it out is a failure worth printing. */
const DAEMON_WAIT_SECONDS = 60;

/** A shell function that waits for `until` to hold, or gives up. Both scripts
 *  need one, and neither should be spelling out the counting: what a reader
 *  wants from a wait is what it is waiting FOR. */
const boundedWait = (name: string, until: string) => `
${name}() {
    waited=0
    until ${until}; do
        [ "$waited" -lt ${DAEMON_WAIT_SECONDS} ] || return 1
        sleep 1
        waited=$((waited + 1))
    done
}`;

/**
 * The restart is not optional: install-ca.sh writes the CA into the system
 * trust store, and a dockerd already running read that store at startup. A
 * dockerd that starts later reads it on the way up and needs nothing.
 *
 * A daemon answering under a pid other than the one we stopped is the only
 * unambiguous signal that the restart has finished. `docker info` alone cannot
 * say: it fails identically for a daemon coming up, one going down, and a
 * container being torn down. The outgoing pid is knowable only here, which is
 * why the wait cannot be left to whoever needs the daemon next.
 */
const INSTALL_CA_SCRIPT = `
dockerd_pid() { pgrep dockerd | head -n1; }

this_container_runs_a_daemon() { [ -n "$(dockerd_pid)" ]; }

a_new_daemon_answers() {
    [ "$(dockerd_pid)" != "$outgoing" ] && docker info >/dev/null 2>&1
}
${boundedWait("wait_for_the_replacement_daemon", "a_new_daemon_answers")}

reload_in_place() { pkill -HUP dockerd || true; }

restart_and_wait() {
    outgoing=$(dockerd_pid)
    service docker restart >/dev/null 2>&1 || { reload_in_place; return 0; }
    wait_for_the_replacement_daemon
}

report_daemon_never_came_back() {
    echo "desolate-ca: this container's docker daemon did not come back" >&2
    echo "             ${DAEMON_WAIT_SECONDS}s after being restarted to pick up the proxy CA." >&2
}

${CA_DIR}/install-ca.sh >/dev/null 2>&1 || exit 1
this_container_runs_a_daemon || exit 0
restart_and_wait || { report_daemon_never_came_back; exit 1; }
`;

/** The docker-in-docker daemon starts WITH the container, so on a cold start it
 *  can still be coming up. One success is enough: whoever restarts this daemon
 *  waits for it, so an answer here is not one on its way down. */
const SHADOW_SCRIPT = `
daemon_answers() { docker info >/dev/null 2>&1; }
${boundedWait("wait_for_the_booting_daemon", "daemon_answers")}

report_no_daemon() {
    echo "!!! no docker daemon answered in ${DAEMON_WAIT_SECONDS}s -- nothing was shadowed."
    echo "    shadowImages needs a daemon of this project's own. Add it:"
    echo '      "features": { "ghcr.io/devcontainers/features/docker-in-docker:2": {} }'
}

shadow_one_image() {
    echo "=== $1"
    ${CA_DIR}/trust-proxy-in-builds.sh --image "$1" --shadow ||
        echo "!!! could not shadow $1 -- builds FROM it will NOT trust the proxy CA"
}

echo "=== shadowing $# base image(s) so that builds FROM them trust the proxy CA"
wait_for_the_booting_daemon || { report_no_daemon; exit 0; }
for image in "$@"; do shadow_one_image "$image"; done
echo "=== done"
`;

/**
 * The two halves of proxy-CA trust, as argv to run AS ROOT in a devcontainer.
 *
 * They are scripts executed in there rather than docker calls out here because
 * of where their effects have to land: a trust store, and a tag in the
 * devcontainer's INNER daemon, neither of which the orchestrator has a path to.
 *
 * The split is the one the shipped scripts already draw. `inContainer` trusts
 * the proxy in the container you are standing in; `inBuilds` trusts it in the
 * containers that container's own BUILDS run in, which is the only lever left
 * for a builder that cannot be handed a build context (an SDK posting to the
 * Engine API cannot express one).
 */
export const trust = {
  inContainer: () => ["sh", "-c", INSTALL_CA_SCRIPT],

  /** The images are ARGUMENTS, never text spliced into the script: they come
   *  from devcontainer.json, this runs as root, and a value that closes a quote
   *  would otherwise be a shell of its own. `$0` names the job, not an image. */
  inBuilds: (images: string[]) => [
    "sh",
    "-c",
    SHADOW_SCRIPT,
    "desolate-shadow-images",
    ...images,
  ],
};

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
