"""An agent, kept running in its workspace, attachable from your own terminal.

  python3 -I agent-holder.py start <name> <dir> -- <command...>   (detaches; prints its state)
  python3 -I agent-holder.py attach <name>                          (the host's `desolate agent attach`)
  python3 -I agent-holder.py list
  python3 -I agent-holder.py stop <name>

Why not tmux: tmux owns the screen, so scrolling and copying are its own (mouse modes
that take one away to give the other). Here the agent's terminal is a pty this holder keeps;
attaching streams it to YOUR terminal, after replaying what it printed recently, so your
terminal's own scrollback, selection and copy work as they do for anything else.

The command runs where `desolate exec` runs it (enter.sh: the project's devcontainer, else
the VM). Everything it prints is also kept in ~/.desolate-agents/<name>.log. The socket is
this user's alone (0600, in a 0700 directory): an agent can attach to nothing but what
already runs as it.

Attach protocol, one line each way per message from the client: "i <base64>" input,
"r <cols> <rows>" a size, "k" stop. The holder sends the terminal's bytes, raw.
"""
import base64
import fcntl
import json
import os
import pty
import select
import signal
import socket
import struct
import sys
import termios
import time

HOME = os.path.expanduser("~")
STATE = os.path.join(HOME, ".desolate-agents")
RUN = os.path.join(os.environ.get("XDG_RUNTIME_DIR") or os.path.join(HOME, ".desolate-agents"), "sockets")
KEEP = 2 * 1024 * 1024  # what is replayed to an attach
LOG_MOST = 64 * 1024 * 1024
ENTER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "enter.sh")
NAME_OK = set("abcdefghijklmnopqrstuvwxyz0123456789-")


def checked(name):
    if not name or len(name) > 40 or not set(name) <= NAME_OK or name[0] == "-":
        sys.exit("agent-holder: a name is lower-case letters, digits and dashes")
    return name


def paths(name):
    return os.path.join(RUN, name + ".sock"), os.path.join(STATE, name + ".json"), os.path.join(STATE, name + ".log")


def write_state(agent, **fields):
    _, state, _ = paths(agent)
    try:
        with open(state) as f:
            current = json.load(f)
    except Exception:
        current = {}
    current.update(fields)
    tmp = state + ".tmp"
    with open(tmp, "w") as f:
        json.dump(current, f)
    os.replace(tmp, state)


def alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def start(name, directory, command):
    for d in (STATE, RUN):
        os.makedirs(d, mode=0o700, exist_ok=True)
        os.chmod(d, 0o700)
    sock_path, state, log = paths(name)
    try:
        with open(state) as f:
            old = json.load(f)
        if old.get("state") == "running" and alive(old.get("holder", 0)):
            sys.exit(f"agent-holder: '{name}' is running already: attach to it, or stop it first")
    except (OSError, ValueError):
        pass
    error = os.path.join(STATE, name + ".err")
    try:
        os.unlink(error)
    except OSError:
        pass
    # Detach: the holder outlives the session that started it.
    if os.fork():
        for _ in range(100):
            time.sleep(0.05)
            if os.path.exists(sock_path) or os.path.exists(error):
                break
        if not os.path.exists(sock_path):
            try:
                with open(error) as f:
                    sys.exit("agent-holder: it did not start:\n" + f.read())
            except OSError:
                sys.exit("agent-holder: it did not start, and said nothing")
        with open(state) as f:
            print(f.read())
        return
    os.setsid()
    if os.fork():
        os._exit(0)
    devnull = os.open(os.devnull, os.O_RDWR)
    for fd in (0, 1, 2):
        os.dup2(devnull, fd)
    try:
        hold(name, directory, command)
    except BaseException:
        import traceback
        with open(error, "w") as f:
            f.write(traceback.format_exc())
    os._exit(0)


def hold(name, directory, command):
    sock_path, _, log_path = paths(name)
    pid, master = pty.fork()
    if pid == 0:
        os.environ["TERM"] = os.environ.get("TERM") or "xterm-256color"
        os.execvp("bash", ["bash", ENTER, directory, "--", *command])
    write_state(name, name=name, state="running", holder=os.getpid(), pid=pid, command=command, directory=directory,
                started=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), lastOutput=None, exit=None)
    resize(master, 120, 40)
    try:
        os.unlink(sock_path)
    except OSError:
        pass
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(sock_path)
    os.chmod(sock_path, 0o600)
    server.listen(8)
    server.setblocking(False)
    log = open(log_path, "ab", buffering=0)
    kept = bytearray()
    clients = {}  # socket -> pending input text
    last_state = 0.0
    child_done = False
    kill_at = 0.0
    while True:
        readable = [server, *clients.keys()] + ([] if child_done else [master])
        ready, _, _ = select.select(readable, [], [], 1.0)
        for r in ready:
            if r is server:
                try:
                    client, _ = server.accept()
                except OSError:
                    continue
                client.setblocking(True)
                try:
                    client.sendall(bytes(kept))
                except OSError:
                    client.close()
                    continue
                client.setblocking(False)
                clients[client] = ""
            elif r is master:
                try:
                    data = os.read(master, 65536)
                except OSError:
                    data = b""
                if not data:
                    child_done = True
                    continue
                kept.extend(data)
                if len(kept) > KEEP:
                    del kept[: len(kept) - KEEP]
                if log.tell() < LOG_MOST:
                    log.write(data)
                for client in list(clients):
                    try:
                        client.setblocking(True)
                        client.sendall(data)
                        client.setblocking(False)
                    except OSError:
                        client.close()
                        clients.pop(client, None)
                now = time.time()
                if now - last_state > 5:
                    last_state = now
                    write_state(name, lastOutput=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))
            else:
                try:
                    chunk = r.recv(65536)
                except OSError:
                    chunk = b""
                if not chunk:
                    r.close()
                    clients.pop(r, None)
                    continue
                text = clients.get(r, "") + chunk.decode("ascii", "replace")
                *lines, rest = text.split("\n")
                clients[r] = rest[-200000:]
                for line in lines:
                    if line.startswith("i ") and not child_done:
                        try:
                            os.write(master, base64.b64decode(line[2:]))
                        except Exception:
                            pass
                    elif line.startswith("r "):
                        try:
                            cols, rows = (int(x) for x in line[2:].split())
                            if 0 < cols <= 1000 and 0 < rows <= 500:
                                resize(master, cols, rows)
                                os.kill(pid, signal.SIGWINCH)
                        except Exception:
                            pass
                    elif line == "k" and not child_done and not kill_at:
                        # As a person would: interrupt it, twice (most agents, Claude Code
                        # among them, end on that), through its own terminal; a signal to
                        # `docker exec`'s client would not reach into the container.
                        try:
                            os.write(master, b"\x03")
                            time.sleep(0.3)
                            os.write(master, b"\x03")
                        except OSError:
                            pass
                        kill_at = time.time() + 3
        if kill_at and not child_done and time.time() > kill_at:
            try:
                os.killpg(os.getpgid(pid), signal.SIGKILL)
            except OSError:
                pass
            kill_at = 0.0
        if child_done:
            _, status = os.waitpid(pid, 0)
            code = os.waitstatus_to_exitcode(status)
            note = f"\r\n[desolate: the agent ended, exit {code}]\r\n".encode()
            kept.extend(note)
            log.write(note)
            write_state(name, state="exited", exit=code, ended=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))
            for client in list(clients):
                try:
                    client.setblocking(True)
                    client.sendall(note)
                    client.close()
                except OSError:
                    pass
            # What it said stays attachable for a while (and in its log for good).
            deadline = time.time() + 600
            while time.time() < deadline:
                ready, _, _ = select.select([server], [], [], 5.0)
                if ready:
                    try:
                        client, _ = server.accept()
                        client.sendall(bytes(kept))
                        client.close()
                    except OSError:
                        pass
            try:
                os.unlink(sock_path)
            except OSError:
                pass
            return


def resize(fd, cols, rows):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def attach(name):
    """stdin: the protocol's lines (from the host); stdout: the terminal's bytes."""
    sock_path, state, log_path = paths(name)
    client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        client.connect(sock_path)
    except OSError:
        # Ended long ago: what it printed last.
        try:
            with open(log_path, "rb") as f:
                f.seek(max(0, os.path.getsize(log_path) - KEEP))
                sys.stdout.buffer.write(f.read())
                sys.stdout.buffer.write(b"\r\n[desolate: this agent is not running]\r\n")
                sys.stdout.flush()
        except OSError:
            sys.exit(f"agent-holder: no agent '{name}' here")
        return
    out = sys.stdout.buffer
    reading = True
    while True:
        ready, _, _ = select.select([client] + ([sys.stdin] if reading else []), [], [])
        if client in ready:
            data = client.recv(65536)
            if not data:
                break
            out.write(data)
            out.flush()
        if reading and sys.stdin in ready:
            line = sys.stdin.buffer.readline()
            if not line:
                reading = False  # nothing more to send; what it prints still comes
                continue
            client.sendall(line)


def listing():
    out = []
    try:
        names = sorted(n[:-5] for n in os.listdir(STATE) if n.endswith(".json"))
    except OSError:
        names = []
    for name in names:
        try:
            with open(os.path.join(STATE, name + ".json")) as f:
                s = json.load(f)
        except Exception:
            continue
        if s.get("state") == "running" and not alive(s.get("holder", 0)):
            s["state"] = "lost"
        out.append({k: s.get(k) for k in ("name", "state", "command", "started", "lastOutput", "exit", "ended")})
    print(json.dumps(out))


def stop(name):
    sock_path, _, _ = paths(name)
    client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        client.connect(sock_path)
        client.sendall(b"k\n")
        # Connected until the holder has read it (it sends the replay first): a second.
        client.settimeout(0.2)
        deadline = time.time() + 1.0
        while time.time() < deadline:
            try:
                if not client.recv(65536):
                    break
            except socket.timeout:
                continue
            except OSError:
                break
        client.close()
        print(json.dumps({"stopped": name}))
    except OSError:
        sys.exit(f"agent-holder: '{name}' is not running")


if __name__ == "__main__":
    args = sys.argv[1:]
    if len(args) >= 4 and args[0] == "start" and args[3] == "--":
        start(checked(args[1]), args[2], args[4:])
    elif len(args) == 2 and args[0] == "attach":
        attach(checked(args[1]))
    elif args == ["list"]:
        listing()
    elif len(args) == 2 and args[0] == "stop":
        stop(checked(args[1]))
    else:
        sys.exit(__doc__)
