/// <reference types="node" />
// The Dockerfile fragment that teaches a base image to trust the proxy CA.
//
// It runs as ROOT in an image the developer's code is then built from, so what
// it does and what it leaves behind are both security-relevant. It is also
// written TWICE -- once here for `"image"`-based projects, once in
// trust-proxy-in-builds.sh for a developer's own compose builds -- and the two
// have to agree, or a project gets a different trust store depending on which
// path derived its base.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  installInstructions,
  SHADOW_LOG,
  shadowImagesCommand,
} from "../../../release/vscode-image/certificates.ts";

const RELEASE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../release",
);

const recipe = installInstructions("vscode");
const lines = recipe.split("\n");
const SYSTEM_BUNDLE = "/etc/ssl/certs/ca-certificates.crt";
const PROXY_CERT = "/usr/local/share/ca-certificates/desolate-proxy.crt";

describe("the CA-trusting recipe", () => {
  test("installs as root and hands the image back to its own user", () => {
    // Root is needed to run the trust tool; leaving it there breaks the
    // devcontainer CLI's assumptions about who the image runs as, and hands a
    // root shell to anything that execs into the derived container.
    assert.equal(lines[0], "USER root");
    assert.equal(lines.filter(Boolean).at(-1), "USER vscode");
    assert.match(installInstructions("root"), /USER root\n$/);
  });

  test("writes the cert where both trust-store families look", () => {
    // One recipe has to cover Debian/Ubuntu/Alpine and the RHEL family,
    // because the base image is the developer's choice, not ours.
    assert.ok(recipe.includes(`COPY ca.pem ${PROXY_CERT}`));
    assert.ok(
      recipe.includes(
        "COPY ca.pem /etc/pki/ca-trust/source/anchors/desolate-proxy.crt",
      ),
    );
  });

  test("a base image with neither tool fails the build", () => {
    // The alternative is an image that silently does not trust the proxy, and
    // the first symptom is an x509 error deep inside a Feature install that
    // mentions no CA at all.
    assert.match(recipe, /update-ca-certificates/);
    assert.match(recipe, /update-ca-trust extract/);
    assert.match(recipe, /exit 1; fi/);
    assert.match(recipe, /^RUN set -eu;/m);
  });

  test("the bundle variables point at the SYSTEM store, not the bare cert", () => {
    // The system bundle now holds the proxy CA *and* every public root.
    // Pointing these at the bare proxy cert would trust only it, so every
    // ordinary HTTPS destination would start failing instead.
    for (const name of [
      "SSL_CERT_FILE",
      "REQUESTS_CA_BUNDLE",
      "CARGO_HTTP_CAINFO",
      "GIT_SSL_CAINFO",
    ])
      assert.ok(
        recipe.includes(`ENV ${name}=${SYSTEM_BUNDLE}`),
        `${name} does not point at ${SYSTEM_BUNDLE}`,
      );
    // Node's is the exception: NODE_EXTRA_CA_CERTS is ADDED to node's built-in
    // roots rather than replacing them, so it names the proxy cert alone.
    assert.ok(recipe.includes(`ENV NODE_EXTRA_CA_CERTS=${PROXY_CERT}`));
  });

  test("they are image ENV, which /etc/profile.d could not be", () => {
    // install-ca.sh writes the same variables to /etc/profile.d, and that is
    // sourced only by LOGIN shells -- a container that execs uvicorn never
    // sees them. As ENV they reach every process, which is the whole reason
    // this recipe exists alongside that script.
    const envs = lines.filter((l) => l.startsWith("ENV "));
    assert.equal(envs.length, 5, `expected 5 ENV lines, got ${envs.length}`);
  });

  test("nothing else is in it", () => {
    // The recipe is printed to the developer before it runs, on the promise
    // that it is the whole of what happens to their base image. Any verb
    // beyond these is a promise broken.
    const verbs = new Set(
      lines.filter(Boolean).map((l) => l.split(" ")[0].replace(/^\s+/, "")),
    );
    assert.deepEqual(
      [...verbs].filter((v) => /^[A-Z]+$/.test(v)).sort(),
      ["COPY", "ENV", "RUN", "USER"],
    );
  });
});

describe("the two derivations agree", () => {
  // trust-proxy-in-builds.sh builds the same fragment with `echo` lines, for
  // developers deriving their own compose bases from inside a devcontainer.
  // Two spellings of one rule drift silently: a project would then trust a
  // different set of roots depending on which path built its base.
  const script = fs.readFileSync(
    path.join(RELEASE, "proxy/container/trust-proxy-in-builds.sh"),
    "utf8",
  );

  test("both copy the cert to the same two locations", () => {
    for (const target of [
      PROXY_CERT,
      "/etc/pki/ca-trust/source/anchors/desolate-proxy.crt",
    ]) {
      assert.ok(recipe.includes(`COPY ca.pem ${target}`));
      assert.ok(
        script.includes(`COPY ca.pem ${target}`),
        `trust-proxy-in-builds.sh does not copy to ${target}`,
      );
    }
  });

  test("both set the same five variables to the same values", () => {
    for (const line of lines.filter((l) => l.startsWith("ENV ")))
      assert.ok(
        script.includes(line),
        `trust-proxy-in-builds.sh is missing: ${line}`,
      );
  });

  test("both restore the base image's user rather than leaving root", () => {
    assert.match(script, /echo "USER \$BASE_USER"/);
  });

  test("both fail closed on an image with no trust tool", () => {
    assert.match(script, /update-ca-certificates/);
    assert.match(script, /update-ca-trust extract/);
    assert.match(script, /exit 1; fi/);
  });

  test("the script goes further, and that divergence is deliberate", () => {
    // The script derives bases the DEVELOPER chose -- node:*-slim, alpine,
    // python:*-slim -- most of which ship no ca-certificates at all, so it
    // installs the package rather than telling them to. This recipe derives the
    // base a DEVCONTAINER image was built from, which has the tooling already.
    // They agree on everything above; this is the one asymmetry, and it is here
    // so the next person to compare them does not read it as drift.
    assert.match(script, /apt-get install .*ca-certificates/);
    assert.match(script, /apk add --no-cache ca-certificates/);
    assert.doesNotMatch(recipe, /apt-get/);
  });
});

describe("deriving a base with no CA tooling at all", () => {
  const script = fs.readFileSync(
    path.join(RELEASE, "proxy/container/trust-proxy-in-builds.sh"),
    "utf8",
  );

  test("the package is installed over transport that works before trust does", () => {
    // The whole branch rests on being able to fetch a package with no CA
    // installed yet. Debian's default sources are plain HTTP, which the proxy
    // passes through untouched; Alpine's are HTTPS and ARE intercepted, so the
    // proxy CA is appended to the bundle alpine ships (without the tool that
    // maintains it) before apk runs. Changing either of those to something that
    // needs trust first is a chicken-and-egg that only shows up on a base image
    // nobody tested with.
    assert.match(
      script,
      /cat \/usr\/local\/share\/ca-certificates\/desolate-proxy\.crt >> \/etc\/ssl\/certs\/ca-certificates\.crt/,
    );
    // Conditional on the bundle already existing: creating one where the base
    // has none leaves a half-built trust store for update-ca-certificates to
    // trip over, and buys nothing (apt does not need it).
    assert.match(script, /if \[ -f \/etc\/ssl\/certs\/ca-certificates\.crt \]/);
  });

  test("every package manager worth covering is covered", () => {
    for (const manager of ["apt-get", "apk", "microdnf", "dnf", "yum"])
      assert.match(
        script,
        new RegExp(`command -v ${manager}\\b`),
        `no branch for ${manager}`,
      );
  });

  test("an image with no package manager still fails, in the old words", () => {
    // distroless and scratch cannot be taught to trust anything, and a loud
    // failure here is far cheaper than an x509 error deep inside a package
    // install. This is the message that case has always printed.
    assert.match(
      script,
      /has neither update-ca-certificates nor update-ca-trust/,
    );
    assert.match(script, /install the ca-certificates package in it first/);
  });
});

describe("--shadow, for builds that take no build context", () => {
  const script = fs.readFileSync(
    path.join(RELEASE, "proxy/container/trust-proxy-in-builds.sh"),
    "utf8",
  );
  // usage() prints line 2 through this marker, so the header IS `--help`.
  const help = script.slice(0, script.indexOf("# WHY THIS IS NEEDED"));

  test("--help documents both halves of it", () => {
    // A flag missing from the header is a flag with no documentation anywhere:
    // there is no second place `--help` reads from.
    assert.match(help, /--shadow/);
    assert.match(help, /--unshadow/);
  });

  test("--shadow and --service are refused together, not silently combined", () => {
    // Two delivery mechanisms for one derivative. Doing both leaves an override
    // file claiming the build is redirected and a tag saying it need not be, so
    // removing either one leaves a build that still works for a reason nobody
    // can see.
    assert.match(script, /--shadow and --service are alternatives/);
  });

  test("the pristine base is pinned, so re-deriving cannot eat itself", () => {
    // Once the tag names our derivative, `FROM $IMAGE` would derive from the
    // derived: --force would stack a second CA layer, and a CA rotation would
    // bake both the old certificate and the new one into the result.
    assert.match(script, /PRISTINE_ALIAS=/);
    assert.match(script, /desolate\.ca\.shadowed-from/);
  });

  test("it can be undone", () => {
    // The one thing this script does that escapes both the desolate-ca/*
    // namespace and the gitignored override file is mutating a tag the user did
    // not opt into per build. An undo is what makes that honest.
    assert.match(script, /^\s*--unshadow\)\s+UNSHADOW=1/m);
  });

  test("the --pull warning is not reused, because it inverts", () => {
    // For the compose flow, --pull fails loudly ("pull access denied"). Under
    // --shadow it SUCCEEDS and quietly restores the untrusting upstream image,
    // turning a clear error into a certificate failure two builds later.
    assert.match(script, /silently puts the untrusting upstream image back/);
  });
});

describe("the shadowImages job", () => {
  const argv = shadowImagesCommand(["node:22-bookworm-slim", "alpine:3.20"]);
  const [command, flag, body, argv0, ...images] = argv;

  test("images are ARGUMENTS, never text spliced into the script", () => {
    // It runs as root, and the values come from devcontainer.json. A value that
    // closed a quote would otherwise be a shell of its own.
    const hostile = shadowImagesCommand(['x"; touch /pwned; :"']);
    assert.equal(hostile[2], body, "the script body varies with its input");
    assert.equal(hostile.at(-1), 'x"; touch /pwned; :"');
  });

  test("$0 is a job name, so the first image is $1", () => {
    assert.deepEqual([command, flag], ["sh", "-c"]);
    assert.equal(argv0, "desolate-shadow-images");
    assert.deepEqual(images, ["node:22-bookworm-slim", "alpine:3.20"]);
    assert.match(body, /for image in "\$@"/);
  });

  test("it waits for the inner daemon instead of assuming one is up", () => {
    // It runs at container start and the docker-in-docker feature's daemon
    // starts WITH the container -- and install-ca.sh has just restarted it, so
    // one successful `docker info` can be a daemon on its way down.
    assert.match(body, /docker info/);
    assert.match(body, /-lt 2/);
    assert.match(body, /-ge 120/);
  });

  test("no daemon is a named config error, not a crash", () => {
    // A project declaring shadowImages without docker-in-docker has nowhere for
    // a tag to live, and never will.
    assert.match(body, /docker-in-docker/);
    assert.match(body, /exit 0/);
  });

  test("one image failing does not take the others with it", () => {
    // Nor the container start. Losing build-time HTTPS for one base image is
    // not a reason to have no editor.
    assert.match(body, /--shadow \|\|\s*\n\s*echo "!!! could not shadow/);
  });

  test("everything it says goes to the file the start line names", () => {
    // It outlives the command that launched it, so there is nowhere else for
    // its errors to go.
    assert.match(body, new RegExp(`^exec >>${SHADOW_LOG} 2>&1$`, "m"));
  });

  test("it calls the script that is actually shipped", () => {
    assert.match(
      body,
      /\/desolate-ca\/trust-proxy-in-builds\.sh --image "\$image" --shadow/,
    );
    assert.ok(
      fs.existsSync(
        path.join(RELEASE, "proxy/container/trust-proxy-in-builds.sh"),
      ),
    );
  });
});
