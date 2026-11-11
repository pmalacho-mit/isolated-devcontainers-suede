# What carries over from v2, and is not ported yet

move-to-vms.md section 10 lists what v3 keeps from v2 "mostly as code". This directory holds
the pieces of that list that have **not** been ported into `release/` yet, with their v2
tests, so that whoever ports one has it in front of them rather than in history. Nothing here
is shipped, run or type-checked: the imports point at v2 files that no longer exist.

The whole of v2 is in history at commit `4f32c77` and on the `release` branch.

| Here | What it is | Where it goes in v3 | Notes |
|---|---|---|---|
| `proxy/addon.py`, `test_addon.py`, `settings.example.json` | the mitmproxy addon: secret substitution, SNI-proven destinations, header confinement, scrubbing, the self-test fixture, on/off and TTL, learn then enforce | **Ported in part**: `release/root/proxy/secrets_addon.py` (proving a destination, the allowlist, header confinement, overlapping names, scrubbing), tested by `tests/v3/t2/07-secrets.test.ts` | Still only here: on/off and TTL (`off`, `until`), the self-test fixture, TLS passthrough. Network rules and learn/enforce are `release/root/proxy/proxy.ts`'s, not the addon's, in v3. |
| `proxy/install-ca.sh`, `trust-proxy-in-builds.sh`, `with-ca.sh`, `certificates.ts` | trusting the proxy's CA in containers and builds | `release/workspace/` | The VM's own trust store is done (`release/workspace/net/trust-ca.sh`). These are for the devcontainer and its image builds, once it is started. |
| `editor/` | the editor server's launch, its gate, held settings, appearance, the extension and its model, the extension's browser test, `docs` for the panel | **Ported**: the gate (`release/workspace/editor-gate.ts`), held settings (`editor-settings.ts`), the launch (`editor.sh`). Still only here: `editor.ts` (launching inside a devcontainer, extensions from `devcontainer.json`, the port map in the environment), appearance, the extension and its model, the browser test | The extension goes to `release/workspace/editor/` (a workspace's) and `release/root/ui/` (the root editor and dashboard, section 4.8). |
| `devcontainer/` | reading `devcontainer.json`, pinning features to digests, JSONC | `release/workspace/` (run `devcontainer up` in the VM) and `release/root/` (freeze the environment, section 4.5) | Shape A: the spec runs unchanged inside the VM; v2's policy is gone. Measured on the M1: it works in a Lima/vz VM (docs/v3/decisions.md). |
| `completion/` | shell completion and its hardening | `release/` | Rewrite for v3's verbs. |
| `agents/` | the dispatchers, the suede factory, telemetry, and their docs | `examples/` | Section 9: everything up to an offer can be scripted. The contract changes from projects and worktrees to domains and workspaces. |
| `status/status.ts`, `panel.ts` | reading statuses for the panel | `release/root/ui/` | The status script itself is ported (`release/workspace/status`, unchanged) and `desolate status` / `board` read it. |
| `transfer/` | v2's bundle transfer, review, and the suede `upstream` push | reference for `desolate upstream` (section 5.5) | Offers, review and push are reimplemented (`release/root/offers.ts`, `push.ts`). The rule that a proposal must not change the dependency's `.github/` is here, and `upstream` needs it. |
