# sample-fastapi -- full-chain + secrets test

Proves two things at once:

1. the three-level path works: Mac browser -> dind relay -> devcontainer ->
   level-3 FastAPI container
2. the secret is never inside any container -- only a placeholder is, and the
   VM proxy substitutes the real value in-flight toward allowlisted hosts only

## Run it

```bash
# on your Mac -- register the real key ONCE, into the VM (never a file here)
./cli.sh secret add SAMPLE-FASTAPI-OPENAI-KEY --hosts api.openai.com

# drag this folder into the web editor at :3000, then:
./cli.sh desolate sample-fastapi        # prints the editor URL + a :8000 URL

# inside the devcontainer terminal (the desolate tab):
cd /workspaces/sample-fastapi
docker compose up --build
```

Then, from your Mac browser on the forwarded `:8000` URL:

| endpoint | shows |
|---|---|
| `/` | the container is reachable through all three levels |
| `/health` | the container sees only `SAMPLE-FASTAPI-OPENAI-KEY` |
| `/live-call` | `200` -- the proxy swapped in the real key on the way out |
| `/exfil-test` | `403` -- same placeholder toward a non-allowlisted host is blocked |

`/exfil-test` is the interesting one: it is the honeypot case. Even code that
deliberately tries to leak the credential can only leak the placeholder, and
the attempt is refused and logged (`./cli.sh proxy logs | grep LEAK`).

## Why there is no .env here

Nothing in this project needs one. The placeholder lives in
`devcontainer.json` (`containerEnv`) and is safe to commit; the real value
lives only in the Colima VM at `/etc/devenv-proxy/settings.json` (0600), below
the sysbox boundary, on a filesystem no container can reach.
