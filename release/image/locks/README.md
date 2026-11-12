# Locks for what the image installs from package registries

`image/provision.sh` installs two tools from registries. Each comes from a lock here that
names every package by its hash, so a build gets exactly what was locked or fails. A
version number alone (the earlier way) fixed only the top package: every dependency was
whatever the registry offered on the day of the build, and mitmproxy runs in the root VM,
beside each domain's secrets.

| tool | lock | install |
|---|---|---|
| mitmproxy (the secrets proxies) | `mitmproxy.txt`: 42 packages, every published file's sha256 | `pip install --no-deps --require-hashes --prefer-binary` |
| the devcontainer CLI | `devcontainer-cli/package-lock.json`: one package (it bundles its dependencies), sha512 | `npm ci --ignore-scripts` |

`provision.sh` refuses a lock that is not for the version in `pins.env`.

## Re-locking (deliberately, when `pins.env` changes)

Never in the root VM: resolving runs a registry's code. In a throwaway container:

```bash
cd release/image/locks
printf 'mitmproxy==<version>\n' > /tmp/requirements.in
docker run --rm -v /tmp:/w -w /w python:3.12-slim-bookworm sh -c \
  'pip install -q pip-tools==7.4.1 && pip-compile -q --generate-hashes --allow-unsafe --strip-extras --no-header -o requirements.txt requirements.in'
cp /tmp/requirements.txt mitmproxy.txt

# set the version in devcontainer-cli/package.json, then:
docker run --rm -v "$PWD/devcontainer-cli:/w" -w /w node:24-bookworm-slim \
  npm install --package-lock-only --ignore-scripts --no-audit --no-fund
```

Python 3.12 is what Ubuntu 24.04 (the image's base) has. Check both architectures install
before committing (`docker run --platform linux/amd64 ...` and the native one), and read
the diff of the lock: a new dependency is a new thing running in the root VM.
