"""A terminal session, recorded: runs a plan in bash on a pty, as a person would type it,
and writes what the terminal showed, with times, as JSON lines (record-terminal.ts plays
them back into xterm.js for a video).

  python3 -I pty-record.py <plan.json> <out.jsonl>

The plan: a list of steps, each one of
  {"type": "a command"}      typed, a key at a time, then Enter
  {"until": "regex", "timeout": 120}   wait until what was printed since the step matches
  {"wait": 2.5}              seconds
  {"key": "\\u001d"}          raw bytes (Ctrl-] here)
  {"caption": "text"}        shown under the terminal from this moment
"""
import base64, json, os, pty, re, select, struct, sys, time, fcntl, termios

plan = json.load(open(sys.argv[1]))
out = open(sys.argv[2], "w")
start = time.time()
def event(**fields):
    out.write(json.dumps({"t": round(time.time() - start, 3), **fields}) + "\n")
    out.flush()

pid, fd = pty.fork()
if pid == 0:
    os.environ["PS1"] = "\\[\\033[1;32m\\]you@mac\\[\\033[0m\\] \\[\\033[1;34m\\]~\\[\\033[0m\\] $ "
    os.environ["TERM"] = "xterm-256color"
    os.execvp("bash", ["bash", "--norc", "--noprofile", "-i"])
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 32, 118, 0, 0))
seen = b""
def pump(seconds):
    global seen
    end = time.time() + seconds
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.05)
        if r:
            try:
                data = os.read(fd, 65536)
            except OSError:
                return
            if not data:
                return
            seen += data
            event(out=base64.b64encode(data).decode())

pump(1.0)
for step in plan:
    if "type" in step:
        seen = b""
        for ch in step["type"]:
            os.write(fd, ch.encode())
            pump(0.03)
        pump(0.4)
        os.write(fd, b"\r")
        pump(0.2)
    elif "until" in step:
        deadline = time.time() + step.get("timeout", 120)
        pattern = re.compile(step["until"].encode())
        while time.time() < deadline and not pattern.search(re.sub(rb"\x1b\[[0-9;?]*[a-zA-Z]", b"", seen)):
            pump(0.2)
        if time.time() >= deadline:
            event(error="timed out waiting for " + step["until"])
    elif "wait" in step:
        pump(step["wait"])
    elif "key" in step:
        os.write(fd, step["key"].encode())
        pump(0.3)
    elif "caption" in step:
        event(caption=step["caption"])
event(end=True)
os.write(fd, b"exit\r")
pump(0.5)
