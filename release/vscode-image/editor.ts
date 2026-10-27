/**
 * editor.ts -- the editor server invocation that runs inside a project's
 * devcontainer.
 *
 * Everything here ends up inside a single-quoted shell string executed as root
 * in an arbitrary base image, so the two values it interpolates -- extension ids
 * and the connection token -- are validated rather than quoted-and-hoped-for.
 * Both validators live here, next to the interpolation they protect.
 *
 * The project's settings are the exception, and deliberately so: they are
 * arbitrary JSON, with no shape worth validating, so they are never
 * interpolated at all. They go in through a quoted heredoc, as data.
 */
import { nonNullObject, type JSONValue } from "./utils.ts";

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

/**
 * Where `customizations.*.settings` land, relative to the server data dir.
 *
 * MACHINE scope, not User. It is the scope VS Code's own Dev Containers
 * extension writes devcontainer.json settings into, and the precedence that
 * follows is the one anybody arriving from VS Code already expects: above the
 * user's own settings, below the workspace's. Writing them as User settings
 * would instead clobber a file that is the user's, and lose to nothing.
 *
 * Nothing applies these otherwise. There is no VS Code CLIENT in this design --
 * desolate boots the server and a browser connects to it -- so the step that
 * would normally carry `settings` into the container has nobody to run it, and
 * a project's settings were silently ignored while its extensions installed
 * fine.
 */
const MACHINE_SETTINGS = "data/Machine/settings.json";

/** In the file, so the "nothing declared any more" path can tell a file
 *  desolate wrote from one somebody else did, and only remove its own. */
const SETTINGS_MARKER = "Managed by desolate";

/** Quoted, so the shell expands NOTHING between the markers: a project's
 *  settings are data, and no value in them can become code. Safe only while no
 *  line of the JSON can be mistaken for this, which is checked, not assumed. */
const SETTINGS_HEREDOC = "__DESOLATE_SETTINGS_EOF__";

/**
 * Put the project's settings in place -- or take desolate's own file away when
 * it stops declaring any, so that deleting the key from devcontainer.json is
 * something that can be seen to have worked.
 *
 * @throws EditorScriptError if the serialized JSON could close the heredoc.
 */
const settingsScript = (settings: Record<string, JSONValue>) => {
  const file = `"$DATA"/${MACHINE_SETTINGS}`;

  if (!Object.keys(settings).length)
    return `
if [ -f ${file} ] && grep -q '${SETTINGS_MARKER}' ${file}; then rm -f ${file}; fi`;

  // JSON.stringify escapes newlines inside strings, so a line here is always
  // JSON syntax and never a bare word -- but the whole safety of the quoting
  // below rests on that, which makes it worth a check rather than a comment.
  const json = JSON.stringify(settings, null, 2);
  if (json.split("\n").includes(SETTINGS_HEREDOC))
    throw new EditorScriptError(
      "refusing to build the editor script: a setting would close the heredoc",
    );

  // settings.json is JSONC -- the editor's own file format -- so the note
  // reaches whoever opens it wondering where these came from.
  return `
mkdir -p "$DATA"/data/Machine
cat > ${file} <<'${SETTINGS_HEREDOC}'
// ${SETTINGS_MARKER}: customizations.*.settings, from devcontainer.json.
// Rewritten on every start. Put settings of your OWN in User settings; this is
// the Machine scope, which sits above User and below the workspace's .vscode/.
${json}
${SETTINGS_HEREDOC}`;
};

/** What a project asks of its editor, as declared under `customizations.*`. */
export interface EditorCustomizations {
  extensions: string[];
  /** Applied at Machine scope; see MACHINE_SETTINGS. */
  settings: Record<string, JSONValue>;
}

/**
 * Read both halves out of a spec's `customizations`, from EVERY namespace.
 *
 * Every namespace, because a project carrying both a `vscode` and a
 * `codespaces` block means both of them, and neither is more this editor's than
 * the other. For settings, a later declaration wins -- the only tie-break that
 * can be stated in one line.
 *
 * The two halves are handled unalike, and the asymmetry is the point.
 * Extension ids are INTERPOLATED into a shell script, so anything that is not a
 * plain marketplace id is dropped rather than quoted-and-hoped-for. Settings
 * are checked for being an object and no further: they configure a hundred
 * extensions this file has never heard of, and deciding which of them are real
 * is not desolate's to do. It is safe to be that permissive only because they
 * never reach the shell as code -- see `settingsScript`.
 */
export const editorCustomizations = (
  customizations: Record<string, any> = {},
): EditorCustomizations => {
  const extensions = new Set<string>();
  const settings: Record<string, JSONValue> = {};

  for (const [name, namespace] of Object.entries(customizations)) {
    for (const id of namespace?.extensions ?? []) {
      if (typeof id !== "string") continue;
      if (isValidExtensionId(id)) extensions.add(id);
      else console.error(`desolate: ignoring malformed extension id '${id}'`);
    }

    if (namespace?.settings === undefined) continue;
    if (nonNullObject(namespace.settings))
      Object.assign(settings, namespace.settings);
    else
      console.error(
        `desolate: ignoring customizations.${name}.settings -- not an object`,
      );
  }

  return { extensions: [...extensions], settings };
};

/** Bash BY NECESSITY: it runs inside arbitrary devcontainer images, where node
 *  may not exist. Applies the declared settings, installs the declared
 *  extensions from Open VSX, then starts the server unless something already
 *  answers on its port -- checked with a real TCP connect, because a pgrep
 *  matches a server that is still booting.
 *
 *  Settings are written BEFORE the server starts, because the server reads them
 *  at boot: applied after, they would take effect on whatever start came next
 *  and look intermittent.
 *
 *  @throws EditorScriptError if the token or any extension id could reach the
 *  shell unvalidated. Callers filter ids first; this is the backstop that makes
 *  the interpolation below safe to read. */
/**
 * DESOLATE_EXTERNAL_<container-port>=<host-port>, and `_URL` beside it (#17):
 * the address a HUMAN opens for a dev server, which an agent inside the
 * container cannot otherwise know -- it sees 5173, the Mac sees 8081. The
 * editor's own port is not among them: its URL carries the connection token.
 *
 * Both halves are checked as digits before they go anywhere near a shell.
 *
 * @throws EditorScriptError for a label or port that is not a port number. */
export const externalEnvironment = (map: Iterable<[string, number]>): [string, string][] => {
  const env: [string, string][] = [];
  for (const [label, hostPort] of map) {
    if (label === "editor") continue;
    if (!/^[1-9][0-9]{0,4}$/.test(label) || !Number.isInteger(hostPort) || hostPort < 1 || hostPort > 65535)
      throw new EditorScriptError(`refusing to export '${label}' -> '${hostPort}': not a port pair`);
    env.push(
      [`DESOLATE_EXTERNAL_${label}`, String(hostPort)],
      [`DESOLATE_EXTERNAL_${label}_URL`, `http://127.0.0.1:${hostPort}`],
    );
  }
  return env;
};

/**
 * DESOLATE_TARGET and DESOLATE_PROJECT: who this container is -- `main` for
 * a project's own tree, the worktree's name otherwise -- for an agent, a
 * harness, or `desolate-status` to say which target it speaks for. Both are
 * names projects.ts has already validated, checked again here, as the ports
 * are, before a shell sees them.
 *
 * @throws EditorScriptError for a name with anything a shell would read. */
export const targetEnvironment = ({ project, worktree }: { project: string; worktree?: string }): [string, string][] => {
  for (const name of [project, worktree ?? "main"])
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name))
      throw new EditorScriptError(`refusing to export '${name}': not a project or worktree name`);
  return [["DESOLATE_TARGET", worktree ?? "main"], ["DESOLATE_PROJECT", project]];
};

/** /etc/profile.d/desolate-ports.sh: the same variables for login shells --
 *  an agent's `bash -l`, a `docker exec ... bash -lc`. */
export const externalProfile = (env: [string, string][]) =>
  [
    "# written by desolate at every start: who this container is, and the host ports a human opens (#17)",
    ...env.map(([name, value]) => `export ${name}=${value}`),
    "",
  ].join("\n");

export const editorStartScript = (
  serverDir: string,
  { extensions, settings }: EditorCustomizations,
  token: string,
  external: [string, string][] = [],
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

  // The server's environment is what its terminals inherit, so these are
  // exported before it starts -- and a server already running with a
  // DIFFERENT map is restarted, or its terminals would keep the old one.
  const exports = external.map(([name, value]) => `export ${name}=${value}`).join("\n");
  const fingerprint = external.map(([name, value]) => `${name}=${value}`).join(" ");
  return `
set -e
SRV=${serverDir}/bin/${SERVER_BIN}
DATA="$HOME/${EDITOR_DATA_DIR}"
mkdir -p "$DATA/extensions"
${exports}
WANT='${fingerprint}'
HAVE=$(cat "$DATA/desolate-external" 2>/dev/null || true)
if [ ! -x "$SRV" ]; then
  echo 'desolate: server not found in container -- is the base image glibc (Debian/Ubuntu)?' >&2
  exit 1
fi
${settingsScript(settings)}
for e in ${extensions.map((e) => `'${e}'`).join(" ")}; do
  "$SRV" --install-extension "$e" \\
      --extensions-dir "$DATA/extensions" --server-data-dir "$DATA" \\
      >/dev/null 2>&1 || echo "desolate: extension unavailable on Open VSX: $e" >&2
done
listening() { (exec 3<>/dev/tcp/127.0.0.1/${EDITOR_INTERNAL_PORT}) 2>/dev/null; }
if listening && [ "$HAVE" != "$WANT" ]; then
  echo 'desolate: the port map changed -- restarting the editor so its terminals see it'
  # The PROCESS GROUP, not the pid: codium-server is a launcher script whose
  # node child holds the port, and killing the launcher alone leaves that
  # child listening with the old environment. setsid made the launcher the
  # group's leader, so the group is the server. The pattern is the backstop
  # for a server started before the pid was kept.
  [ -s "$DATA/server.pid" ] && kill -- "-$(cat "$DATA/server.pid")" 2>/dev/null || true
  for _ in $(seq 1 40); do listening || break; sleep 0.25; done
  if listening; then
    pkill -f "server-main.js --host 0.0.0.0 --port ${EDITOR_INTERNAL_PORT}" 2>/dev/null || true
    for _ in $(seq 1 40); do listening || break; sleep 0.25; done
  fi
  listening && { echo 'desolate: the old editor would not stop; its terminals keep the old ports' >&2; }
fi
if listening; then
  echo 'desolate: editor already listening'
else
  setsid nohup "$SRV" \\
    --host 0.0.0.0 --port ${EDITOR_INTERNAL_PORT} \\
    --connection-token '${token}' \\
    --extensions-dir "$DATA/extensions" --server-data-dir "$DATA" \\
    >${EDITOR_LOG} 2>&1 < /dev/null &
  echo $! > "$DATA/server.pid"
  printf '%s' "$WANT" > "$DATA/desolate-external"
  sleep 2
fi`;
};
