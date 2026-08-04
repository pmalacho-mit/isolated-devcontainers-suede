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

import { installInstructions } from "../../../release/vscode-image/certificates.ts";

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
});
