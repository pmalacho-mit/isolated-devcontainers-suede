/**
 * editor.ts -- the editor server invocation that runs inside a project's
 * devcontainer.
 *
 * Everything here ends up inside a single-quoted shell string executed as root
 * in an arbitrary base image, so the two values it interpolates -- extension ids
 * and the connection token -- are validated rather than quoted-and-hoped-for.
 * Both validators live here, next to the interpolation they protect.
 */

/** Port the server listens on inside the container. Fixed: the relay maps a
 *  freely-chosen host port onto it, so nothing outside needs to agree on it. */
export const EDITOR_INTERNAL_PORT = 31580;

/** The server executable inside `<serverDir>/bin`.
 *
 *  THE ONE PLACE the editor distribution is named. overlay.ts derives its
 *  mount proof from this, docker-compose.yml's entrypoint and volume-init must
 *  agree with it, and preflight.sh asserts the same path. A second literal
 *  anywhere is a silent way for the seeded server and the executed server to
 *  drift apart. */
export const SERVER_BIN = "codium-server";

/** Per-project editor state inside the devcontainer, relative to $HOME.
 *
 *  Deliberately NOT the name a previous distribution used: a directory holding
 *  another server's extensions and machine state must not be inherited when the
 *  distribution changes, or the first symptom is an extension host that fails
 *  for reasons no log explains. */
export const EDITOR_DATA_DIR = ".desolate-editor";

/** Where the editor's stdout/stderr lands inside the devcontainer. Read back by
 *  desolate.ts when the start probe fails, so both must name the same file. */
export const EDITOR_LOG = "/tmp/desolate-editor.log";

/** 24 random bytes as lowercase hex.
 *
 *  A token reaches the script inside single quotes, so one apostrophe in it
 *  closes the quoting and the remainder runs as root in the container. The
 *  shape is fixed, so requiring it costs nothing. */
const TOKEN = /^[0-9a-f]{48}$/;

export const isValidToken = (token: string) => TOKEN.test(token);

export const mintToken = (randomBytes: (length: number) => Uint8Array) =>
  [...randomBytes(24)].map((b) => b.toString(16).padStart(2, "0")).join("");

/** A marketplace id: `publisher.name`, optionally `@version`.
 *
 *  Same reasoning as the token -- these are interpolated into the same script.
 *  Anything else is dropped rather than escaped. */
const EXTENSION_ID =
  /^[A-Za-z0-9][A-Za-z0-9._-]*\.[A-Za-z0-9][A-Za-z0-9._-]*(@[A-Za-z0-9._-]+)?$/;

export const isValidExtensionId = (id: unknown): id is string =>
  typeof id === "string" && EXTENSION_ID.test(id);

export class EditorScriptError extends Error {}

/** Bash BY NECESSITY: it runs inside arbitrary devcontainer images, where node
 *  may not exist. Installs the declared extensions from Open VSX, then starts
 *  the server unless something already answers on its port -- checked with a
 *  real TCP connect, because a pgrep matches a server that is still booting.
 *
 *  @throws EditorScriptError if the token or any extension id could reach the
 *  shell unvalidated. Callers filter ids first; this is the backstop that makes
 *  the interpolation below safe to read. */
export const editorStartScript = (
  serverDir: string,
  extensions: string[],
  token: string,
) => {
  if (!isValidToken(token))
    throw new EditorScriptError(
      "refusing to build the editor script: the connection token is not 48 hex characters",
    );

  const rejected = extensions.filter((id) => !isValidExtensionId(id));
  if (rejected.length)
    throw new EditorScriptError(
      `refusing to build the editor script: malformed extension ids ${rejected.join(", ")}`,
    );

  return `
set -e
SRV=${serverDir}/bin/${SERVER_BIN}
DATA="$HOME/${EDITOR_DATA_DIR}"
mkdir -p "$DATA/extensions"
if [ ! -x "$SRV" ]; then
  echo 'desolate: server not found in container -- is the base image glibc (Debian/Ubuntu)?' >&2
  exit 1
fi
for e in ${extensions.map((e) => `'${e}'`).join(" ")}; do
  "$SRV" --install-extension "$e" \\
      --extensions-dir "$DATA/extensions" --server-data-dir "$DATA" \\
      >/dev/null 2>&1 || echo "desolate: extension unavailable on Open VSX: $e" >&2
done
if (exec 3<>/dev/tcp/127.0.0.1/${EDITOR_INTERNAL_PORT}) 2>/dev/null; then
  exec 3>&- 3<&-
  echo 'desolate: editor already listening'
else
  setsid nohup "$SRV" \\
    --host 0.0.0.0 --port ${EDITOR_INTERNAL_PORT} \\
    --connection-token '${token}' \\
    --extensions-dir "$DATA/extensions" --server-data-dir "$DATA" \\
    >${EDITOR_LOG} 2>&1 < /dev/null &
  sleep 2
fi`;
};
