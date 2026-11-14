// T1. What the dashboard may ask the host to do (shared/actions.ts), and what the spec
// desolate hands the devcontainer CLI looks like (workspace/devcontainer.ts): pure functions.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hostArgv } from "../../../release/shared/actions.ts";
import { parse as parseJsonc } from "../../../release/shared/jsonc.ts";
import { extensionsOf, forwardsOf, overrideOf } from "../../../release/workspace/devcontainer.ts";

describe("T1 the dashboard's requests to the host", () => {
  it("each kind becomes one fixed command", () => {
    assert.deepEqual(hostArgv("workspace.start", { domain: "dev", workspace: "w1" }), ["start", "dev/w1"]);
    assert.deepEqual(hostArgv("workspace.stop", { domain: "dev", workspace: "w1" }), ["stop", "dev/w1"]);
    assert.deepEqual(hostArgv("workspace.up", { domain: "dev" }), ["up", "dev"]);
    assert.deepEqual(hostArgv("workspace.up", { domain: "dev", workspace: "issue-12" }), ["up", "dev", "--name", "issue-12"]);
    assert.deepEqual(hostArgv("repo.fetch", { repo: "acme/widgets" }), ["fetch", "acme/widgets"]);
    assert.deepEqual(hostArgv("domain.create", { domain: "dev", title: "widgets work" }), ["domain", "create", "dev", "--title", "widgets work"]);
    assert.deepEqual(hostArgv("domain.add", { domain: "dev", repo: "acme/widgets" }), ["domain", "dev", "add", "--repo", "acme/widgets"]);
  });
  it("nothing else does: unknown kinds, names that are not names, anything that could be an option", () => {
    for (const [kind, args] of [
      ["workspace.rm", { domain: "dev", workspace: "w1" }], ["destroy", {}], ["push", { domain: "dev" }], ["constructor", {}], ["__proto__", {}], ["toString", {}],
      ["workspace.start", { domain: "dev" }], ["workspace.start", { domain: "dev", workspace: "../x" }], ["workspace.start", { domain: "--all", workspace: "w1" }],
      ["workspace.up", { domain: "dev", workspace: "--fetch" }], ["workspace.up", { domain: "dev; rm -rf ~" }], ["repo.fetch", { repo: "--upload-pack=x" }], ["repo.fetch", { repo: "acme" }],
      ["domain.add", { domain: "dev", repo: "acme/widgets/../x" }], ["domain.create", { domain: "Dev" }],
    ] as [string, Record<string, string>][])
      assert.equal(hostArgv(kind, args), null, `${kind} ${JSON.stringify(args)}`);
    assert.equal(hostArgv("workspace.start", null), null);
    assert.equal(hostArgv(7, {}), null);
    assert.equal(hostArgv("workspace.start", { domain: ["dev"], workspace: "w1" }), null, "an argument that is not a string is no argument");
    // A title that looks like an option, or carries a control character, is dropped: the domain is made without it.
    assert.deepEqual(hostArgv("domain.create", { domain: "dev", title: "--help" }), ["domain", "create", "dev"]);
    assert.deepEqual(hostArgv("domain.create", { domain: "dev", title: "a\x1b[2Jb" }), ["domain", "create", "dev"]);
  });
});

describe("T1 the spec desolate hands the devcontainer CLI", () => {
  const spec = parseJsonc(`{
    // comments and a trailing comma, as specs are written
    "image": "example/dev:1",
    "runArgs": ["--cap-add=SYS_PTRACE", "--network=none", "--net", "--privileged"],
    "mounts": ["source=cache,target=/cache,type=volume"],
    "containerEnv": { "MINE": "1", "SSL_CERT_FILE": "/my/own/bundle" },
    "customizations": { "vscode": { "extensions": ["rust-lang.rust-analyzer", "not an id", "a.b@1.2.3"] }, "other": { "extensions": ["x.y; rm -rf /"] } },
  }`) as Record<string, unknown>;
  const merged = overrideOf(spec, "/workspaces/acme/app", "/home/dev") as { runArgs: string[]; mounts: string[]; containerEnv: Record<string, string>; workspaceFolder: string; workspaceMount: string; image: string };
  it("keeps the project's spec, and adds the VM's paths, network and mounts", () => {
    assert.equal(merged.image, "example/dev:1");
    assert.equal(merged.workspaceFolder, "/workspaces/acme/app");
    assert.equal(merged.workspaceMount, "source=/workspaces,target=/workspaces,type=bind");
    assert.deepEqual(merged.runArgs, ["--cap-add=SYS_PTRACE", "--privileged", "--network=host"], "the spec's own arguments stay (nothing is refused); only its choice of network gives way");
    assert.equal(merged.mounts[0], "source=cache,target=/cache,type=volume");
    assert.ok(merged.mounts.includes("source=/desolate/mirrors,target=/desolate/mirrors,type=bind,readonly"), "the mirrors, read-only, at their own path");
    assert.ok(merged.mounts.includes("source=/desolate/inbox,target=/desolate/inbox,type=bind,readonly"));
    assert.ok(merged.mounts.includes("source=/desolate/outbox,target=/desolate/outbox,type=bind"));
    assert.deepEqual([merged.containerEnv.MINE, merged.containerEnv.SSL_CERT_FILE, merged.containerEnv.GIT_CONFIG_KEY_0], ["1", "/my/own/bundle", "safe.directory"], "the spec's own environment wins over desolate's");
  });
  it("a compose spec: its own services and network, and the VM's paths and mounts in its primary service", () => {
    const compose = overrideOf({ dockerComposeFile: "compose.yml", service: "app", workspaceFolder: "/src", mounts: ["source=v,target=/v,type=volume"], runArgs: ["--x"] }, "/workspaces/acme/app", "/home/dev") as { [k: string]: unknown; mounts: string[] };
    assert.deepEqual([compose.dockerComposeFile, compose.service, compose.runArgs, compose.workspaceMount], ["compose.yml", "app", ["--x"], undefined], "no network is chosen for it: compose ignores runArgs, and its services find each other by name");
    assert.equal(compose.workspaceFolder, "/workspaces/acme/app", "the checkout's own path, where the domain's .git is named");
    assert.equal(compose.mounts[0], "source=v,target=/v,type=volume");
    assert.equal(compose.mounts.at(-1), "source=/workspaces,target=/workspaces,type=bind", "the VM's /workspaces at /workspaces (over the project's own mount there, which compose merges by target)");
    // The CLI writes a compose mount as `source:target` and drops its options: the mode rides in the target.
    assert.ok(compose.mounts.includes("source=/desolate/mirrors,target=/desolate/mirrors:ro,type=bind"), "the mirrors, read-only, at their own path");
    assert.ok(compose.mounts.includes("source=/desolate/outbox,target=/desolate/outbox,type=bind"));
    assert.ok(compose.mounts.includes("source=/run/desolate,target=/run/desolate,type=bind"), "where svcnet.ts's socket is, for the VM");
    // CONTROL: a single container's read-only mounts say so in the CLI's own way.
    assert.ok(!merged.mounts.some((m) => m.includes(":ro")));
  });
  it("forwardPorts that name another compose service are carried there; the rest need nothing", () => {
    assert.deepEqual(forwardsOf({ service: "app", forwardPorts: [8000, "db:5432", "app:3000", "localhost:4000", "cache:6379", "db:80", "x:y", "a b:1", "db:99999", "redis:5432"] }), [{ port: 5432, host: "db" }, { port: 6379, host: "cache" }]);
    assert.deepEqual(forwardsOf({ forwardPorts: "db:5432" }), []);
  });
  it("the domain's package caches (C4): mounted and named for a container and for compose, and the spec's own setting wins", () => {
    assert.ok(merged.mounts.includes("source=/desolate/cache,target=/desolate/cache,type=bind"), "the domain's cache, writable, at its own path");
    assert.deepEqual([merged.containerEnv.npm_config_cache, merged.containerEnv.PIP_CACHE_DIR, merged.containerEnv.GOMODCACHE], ["/desolate/cache/npm", "/desolate/cache/pip", "/desolate/cache/go-mod"]);
    assert.equal(merged.containerEnv.CARGO_HOME, undefined, "never where a tool installs itself");
    const compose = overrideOf({ dockerComposeFile: "compose.yml", service: "app" }, "/workspaces/acme/app", "/home/dev") as { containerEnv: Record<string, string>; mounts: string[] };
    assert.equal(compose.containerEnv.npm_config_cache, "/desolate/cache/npm", "the primary compose service is given the mount, so it is pointed at it");
    assert.ok(compose.mounts.includes("source=/desolate/cache,target=/desolate/cache,type=bind"));
    const own = overrideOf({ image: "x", containerEnv: { npm_config_cache: "/home/node/.npm" } }, "/workspaces/acme/app", "/home/dev") as { containerEnv: Record<string, string> };
    assert.equal(own.containerEnv.npm_config_cache, "/home/node/.npm");
  });
  it("extension ids are taken only if they are ids", () => {
    assert.deepEqual(extensionsOf(spec), ["rust-lang.rust-analyzer", "a.b@1.2.3"]);
    assert.deepEqual(extensionsOf({ customizations: "nonsense" }), []);
  });
});
