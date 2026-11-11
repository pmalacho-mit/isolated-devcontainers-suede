#!/usr/bin/env python3
"""A person at a terminal, for the tests: run a command on a pseudo-terminal, and when it
shows a prompt containing WAIT, type ANSWER and Enter.

    person.py <wait-for-text> <answer> -- <command> [args...]

This is the fabricated terminal that docs/v3/decisions.md says the push confirmation cannot
tell from a real one. The tests use it to play the person; nothing in desolate uses it.
Prints everything the command wrote, and exits with its exit code.
"""
import os, pty, select, sys

split = sys.argv.index("--")
wait, answer = sys.argv[1], sys.argv[2]
command = sys.argv[split + 1:]
pid, fd = pty.fork()
if pid == 0:
    os.execvp(command[0], command)
seen = b""
typed = False
while True:
    try:
        ready, _, _ = select.select([fd], [], [], 120)
        if not ready:
            break
        data = os.read(fd, 65536)
    except OSError:
        break
    if not data:
        break
    seen += data
    if not typed and wait.encode() in seen:
        os.write(fd, answer.encode() + b"\n")
        typed = True
_, status = os.waitpid(pid, 0)
sys.stdout.write(seen.decode("utf-8", "replace").replace("\r\n", "\n"))
sys.exit(os.waitstatus_to_exitcode(status))
