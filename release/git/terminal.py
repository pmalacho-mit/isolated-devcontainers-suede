#!/usr/bin/env python3
# The git terminal's far end (host/git-vm.ts): a bash in a pseudo-terminal, in the git VM.
# The host has no terminal to give ssh, so this makes one here and speaks a small protocol
# on stdin: one line per message, "i <base64 bytes>" (what was typed) or "r <cols> <rows>"
# (a resize). What the terminal prints goes to stdout as it is.
#
#   python3 -I terminal.py <directory>     (-I: nothing beside this file is imported in place of a module)
import base64, fcntl, os, pty, select, struct, sys, termios

where = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser("~")
pid, fd = pty.fork()
if pid == 0:
    try:
        os.chdir(where)
    except OSError:
        os.chdir(os.path.expanduser("~"))
    os.environ["TERM"] = "xterm-256color"
    os.execvp("bash", ["bash", "-l"])

def resize(cols, rows):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))

resize(120, 32)
os.set_blocking(fd, False)
pending = b""
typed = b""
stdin = sys.stdin.fileno()
while True:
    try:
        ready, writable, _ = select.select([fd, stdin], [fd] if typed else [], [])
    except InterruptedError:
        continue
    if fd in writable and typed:
        # What was typed goes in as the shell takes it, without stopping its output.
        try:
            typed = typed[os.write(fd, typed):]
        except BlockingIOError:
            pass
        except OSError:
            break
    if fd in ready:
        try:
            data = os.read(fd, 65536)
        except BlockingIOError:
            data = None
        except OSError:
            break
        if data == b"":
            break
        if data:
            os.write(1, data)
    if stdin in ready:
        chunk = os.read(stdin, 65536)
        if not chunk:
            break
        pending += chunk
        while b"\n" in pending:
            line, pending = pending.split(b"\n", 1)
            try:
                kind, _, rest = line.decode("ascii").partition(" ")
                if kind == "i" and len(typed) < 4 * 1024 * 1024:
                    typed += base64.b64decode(rest, validate=True)
                elif kind == "r":
                    cols, rows = (int(x) for x in rest.split())
                    if 1 <= cols <= 1000 and 1 <= rows <= 500:
                        resize(cols, rows)
            except (ValueError, UnicodeDecodeError):
                pass
try:
    os.kill(pid, 9)
except OSError:
    pass
