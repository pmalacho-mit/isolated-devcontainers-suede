# What carries over from v2, and is not ported yet

move-to-vms.md section 10 lists what v3 keeps from v2 "mostly as code". This directory holds
the pieces of that list that have **not** been ported into `release/` yet, with their v2
tests, so that whoever ports one has it in front of them rather than in history. Nothing here
is shipped, run or type-checked: the imports point at v2 files that no longer exist.

The whole of v2 is in history at commit `4f32c77` and on the `release` branch.

| Here | What it is | Where it goes in v3 | Notes |
|---|---|---|---|
| `proxy/addon.py`, `test_addon.py`, `settings.example.json` | the mitmproxy addon: secret substitution, SNI-proven destinations, header confinement, scrubbing, the self-test fixture, on/off and TTL, learn then enforce | `release/root/proxy/`, replacing `proxy.ts` behind the same `CONNECT` interface, one instance per workspace | It was written for transparent mode. In v3 the workspace's relay sends `CONNECT name:port`, so mitmproxy runs in regular mode; `proven_host` (the client's SNI) still holds; `project_of(flow)` becomes the instance's own domain and workspace (attribution by link). This is Phase 4. |
| `proxy/install-ca.sh`, `trust-proxy-in-builds.sh`, `with-ca.sh`, `certificates.ts` | trusting the proxy's CA in containers and builds | `release/workspace/` | Needed once the proxy terminates TLS. Section 10: the CA is installed in the workspace VM's own trust store at boot. |
| `editor/` | the editor server's launch, its gate, held settings, appearance, the extension and its model, the extension's browser test, `docs` for the panel | `release/workspace/editor/` (a workspace's editor) and `release/root/ui/` (the root editor and dashboard, section 4.8) | P1 is not delivered until this lands: no workspace has an editor yet. `hosts.ts` and the ingress host check are already done in `release/shared/names.ts` and `release/host/daemon.ts`. |
| `devcontainer/` | reading `devcontainer.json`, pinning features to digests, JSONC | `release/workspace/` (run `devcontainer up` in the VM) and `release/root/` (freeze the environment, section 4.5) | Shape A: the spec runs unchanged inside the VM; v2's policy is gone. Measured on the M1: it works in a Lima/vz VM (docs/v3/decisions.md). |
| `completion/` | shell completion and its hardening | `release/` | Rewrite for v3's verbs. |
| `agents/` | the dispatchers, the suede factory, telemetry, and their docs | `examples/` | Section 9: everything up to an offer can be scripted. The contract changes from projects and worktrees to domains and workspaces. |
| `status/status.ts`, `panel.ts` | reading statuses for the panel | `release/root/ui/` | The status script itself is ported (`release/workspace/status`, unchanged) and `desolate status` / `board` read it. |
| `transfer/` | v2's bundle transfer, review, and the suede `upstream` push | reference for `desolate upstream` (section 5.5) | Offers, review and push are reimplemented (`release/root/offers.ts`, `push.ts`). The rule that a proposal must not change the dependency's `.github/` is here, and `upstream` needs it. |
