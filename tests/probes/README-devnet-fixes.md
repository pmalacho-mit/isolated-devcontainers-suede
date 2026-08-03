# Fixes for reachability across the desolate bridge

Run `./tests/probes/devnet-reachability.sh` first. Read its step 0 before its
step 1 — the sysctl explains the results rather than the other way round.

Remember which way round the verdicts read: **REFUSED means reachable.** A
refusal is the far end's kernel sending RST, which it can only do if the packet
got there. Only TIMEOUT means the ruleset stopped it.

| step 1 result | what it means | do |
|---|---|---|
| editor TIMEOUT | bridged traffic is filtered; the README's claim holds as written | nothing |
| editor REFUSED or CONNECTED | the forward-chain drop does not cover bridged traffic | **A**, then decide on **B**/**C** |
| NO RESULT | the probe container died; you learned nothing | re-run; do not read it as "blocked" |

## What is and is not at stake

Be precise about this before spending effort, because the instinct is to
over-rate it.

A devcontainer that can open TCP to `desolate-vscode:3000` gets **the login
page**. The editor is token-gated, and the token is not in any devcontainer. The
orchestrator has no TCP listener at all — the broker is a unix socket in a volume
no devcontainer mounts, so reaching its IP buys nothing.

So this is not an escape. What it is:

- an **online guessing surface** for `VSCODE_TOKEN`, from a machine the attacker
  already controls, with no rate limiting and no logging;
- a **pivot** if the editor ever grows an unauthenticated endpoint, or a
  pre-auth bug;
- a gap between what the README claims (`nothing from the container world leaves
  the VM except via the proxy`) and what is enforced. The claim is true of
  **routed** traffic. Say so, or make it true.

Fix A is the honest-documentation one and is worth doing regardless. B and C are
judgement calls.

## A. Make the claim match the enforcement

In `release/proxy/vm/nftables-desolate.conf`, the forward chain's closing drop
carries an implicit assumption worth writing down:

```
# Default-deny: nothing from the container world leaves the VM except
# via the proxy (18080) and the local resolver (5353), which are INPUT,
# not FORWARD, after the redirect above.
iifname $DESOLATE_IF counter drop
```

Add:

```
# ROUTED traffic only. Container-to-container traffic on this bridge is
# switched, not routed, and reaches the forward hook only when br_netfilter is
# loaded with bridge-nf-call-iptables=1. Do not read this rule as isolating
# the stack's containers from each other -- see tests/probes/devnet-reachability.sh.
```

and correct the README's "Isolation model" section the same way.

## B. Isolate at the bridge (if you want it enforced)

Two options, and the second is much better.

**B1 — turn on bridge filtering.** Setting `bridge-nf-call-iptables=1` in the VM
makes the existing drop apply to bridged traffic too. Tempting, and a trap: it
applies to *all* bridges on the VM, changes the path every container's packets
take, and it will break the orchestrator's `fetch(http://dind:PORT)` editor
probe, since that is bridged and not an established flow when the SYN goes out.
You would then need an explicit accept for orchestrator→dind. Global sysctl,
non-local effects — this is the option that looks cheap and is not.

**B2 — put the outer containers on separate networks.** The stack has three
containers with a clear communication graph, and it currently runs them all on
one flat segment:

```
vscode        --(unix socket, broker-run volume)-->  orchestrator
orchestrator  --(unix socket, inner-run volume)-->   dind
orchestrator  --(TCP, editor probe)-->               dind
dind          --(TCP, egress)-->                     the VM/proxy
```

`vscode` needs **no** network path to `dind` at all — it reaches everything
through the broker socket. So in `docker-compose.yml`:

```yaml
networks:
  devnet:            # dind's egress path; the nftables rules are armed for this
    driver: bridge
    driver_opts:
      com.docker.network.bridge.name: br-desolate
  brokernet:         # orchestrator <-> dind, for the editor probe only
    driver: bridge
    internal: true
```

with `vscode` on neither (it publishes to the host and needs no peer), `dind` on
both, and `orchestrator` on both. A devcontainer NATing out of dind then lands on
`devnet`, where the editor container simply is not.

Check before doing this: `dind` publishes the dev-server range, and the relay
chain runs Mac → dind's netns → relay. Confirm publishing still works with dind
on two networks, and re-run `cli.sh preflight` — `ensure_vm_proxy` resolves the
bridge by gateway, so keep `devnet` as the one the rules are armed for, and keep
its pinned name.

## C. Per-project networks on the inner daemon

This is the separate, already-documented gap: `--icc=true` in
`docker-compose.yml` means all devcontainers share dind's default bridge and can
reach each other. B does nothing about it — they are two different bridges, and
conflating them is easy.

The fix is a network per project, created by `desolate.ts` next to the volumes it
already manages:

```ts
// alongside overlay.ensureVolume(...)
docker.network.ensure(`${volumeNamespace(project)}-net`);
```

then pass `--network` to `devcontainer up`, and join each relay to that network
instead of discovering one via `docker.container.networks(cid)`.

Two things to work through first:

- `recreateRelays` currently picks "the first network with an address" and warns
  when there are several. With a per-project network the relay should join *that*
  one by name, which is simpler and removes the warning path.
- The policy allowlist has no `--network` flag, deliberately. `desolate` passing
  it as a CLI argument to `devcontainer up` is not the same thing as a project
  requesting it in `runArgs`, so the allowlist does not need to change — but
  check that a project cannot then reach the flag by another route.

Worth doing if you run genuinely untrusted code in more than one project at a
time. The README's current advice — separate stacks per trust tier — remains the
stronger answer either way.
