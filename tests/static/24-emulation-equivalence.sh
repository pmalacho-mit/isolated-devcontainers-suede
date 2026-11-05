#!/usr/bin/env bash
# x86 emulation equivalence tooling (issue #37): the pieces that decide a
# verdict, checked without Docker or a VM.
#  - x87print.py must print an 80-bit value exactly as x86 gdb does (glibc
#    printf "%.100Le"), including the encodings aarch64 gdb refuses. Vectors
#    below came from glibc 2.36 on amd64.
#  - compare.py must apply v86_64 run.js's rules: AF/OF etc. are compared,
#    TF/IF are not, x87 within 1e-7 passes, "invalid" slots are skipped.
set -uo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
# shellcheck source=../lib/harness.sh
. "$ROOT/tests/lib/harness.sh"
EQ="$RELEASE/emulation-equivalence"
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
mkdir -p "$T/stub"; printf 'class Command:\n    def __init__(self, *a): pass\nCOMMAND_DATA = 0\n' > "$T/stub/gdb.py"

group "x87print.py matches glibc %.100Le"
cat > "$T/vectors" <<'VEC'
4000c90fdaa22168c235 3.1415926535897932385128089594061862044327426701784133911132812500000000000000000000000000000000000000e+00
3fff8000000000000000 1.0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000e+00
bfca8d313198a2e03800 -1.2246467991473532071737640294583966046256921246775800637962561268068384379148483276367187500000000000e-16
00000000000000000000 0.0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000e+00
80000000000000000000 -0.0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000e+00
00000000000000000001 3.6451995318824746025284059336194198163990508156935633437209804870283716886333977368095607086258272052e-4951
00008000000000000001 3.6451995318824746025284059336194198163990508156935633437209804870283716886333977368095607086258272052e-4951
00007fffffffffffffff 3.3621031431120935058981578641335051423452387514845292584689221482393863650186309183402555375017164492e-4932
7fff8000000000000000 inf
ffff8000000000000000 -inf
7fffc000000000000000 nan
7fff0000000000000001 nan
ffff4000000000000000 -nan
3fff0123456789abcdef nan
ffff2100352100352100 -nan
ffffa100352100352100 -nan
7ffeffffffffffffffff 1.1897314953572317650212638530309702051690633222946242004403237338917370055229707226164102903365288829e+4932
00018000000000000000 3.3621031431120935062626778173217526025980793448464712401088272298087426993907289670430927063650562229e-4932
3ffe8000000000000000 5.0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000e-01
3ffdaaaaaaaaaaaaaaab 3.3333333333333333334236835143737920361672877334058284759521484375000000000000000000000000000000000000e-01
VEC
OUT=$(PYTHONPATH="$T/stub:$EQ" python3 -c '
import sys; from x87print import fmt
bad = [l.split()[0] for l in open(sys.argv[1]) if fmt(int(l.split()[0], 16)) != l.split()[1]]
print("mismatch:", *bad) if bad else print("all match")' "$T/vectors" 2>&1)
assert_eq "20 patterns (normal, denormal, pseudo-denormal, inf, NaN, pseudo-NaN, unnormal)" "$OUT" "all match"

group "compare.py applies run.js's rules"
python3 - "$T" <<'PY'
import sys, os
base = sys.argv[1]
def fixture(eflags=0x202, st0="1.0e+00", sig=None, raw_st0="0x3fff8000000000000000"):
    a = [0]*8 + [0x80027] + [st0] + ['"invalid"']*7 + [0]*16 + [0]*32 + [0]*2048 + [eflags, 0x3fff, 0x3800]
    t = ""
    if sig: t += f"Program received signal {sig}, x.\nCatchpoint 2 (signal {sig})\n"
    t += "---BEGIN JSON---\n[\n" + ",\n".join(map(str, a)) + "\n]\n---END JSON---\n"
    t += f"---BEGIN RAW---\neflags         {eflags:#x}   [ ]\nst0            1 (raw {raw_st0})\n---END RAW---\n"
    return t
cases = {"same": {}, "af": {"eflags": 0x202 | 1 << 4}, "tf": {"eflags": 0x202 | 1 << 8},
         "close": {"st0": "1.00000001e+00", "raw_st0": "0x3fff8000000abcdef000"}, "far": {"st0": "1.001e+00", "raw_st0": "0x3fff8020c49ba5e353f8"},
         "exc": {"sig": "SIGFPE"}}
for d in ("ref", "emu"):
    os.makedirs(f"{base}/{d}")
    open(f"{base}/{d}/IMG_SHA256", "w").write("x\n"); open(f"{base}/{d}/TOOLCHAIN", "w").write(d + "\n")
    for n, kw in cases.items():
        open(f"{base}/{d}/{n}.fixture", "w").write(fixture(**(kw if d == "emu" else {"sig": kw.get("sig")} if n == "exc" else {})))
PY
OUT=$(python3 "$EQ/compare.py" "$T/emu" "$T/ref" --json "$T/r.json" 2>&1)
R=$(python3 -c 'import json,sys; r=json.load(open(sys.argv[1]))["vs_ref"]; r=list(r.values())[0]["results"]; print(" ".join("%s:%d%d" % (k, bool(v["runner"]), bool(v["raw"])) for k, v in sorted(r.items())))' "$T/r.json")
assert_eq "runner/raw verdicts per case" "$R" "af:11 close:01 exc:00 far:11 same:00 tf:01"
assert_contains "  AF is named" "$OUT" "eflags: AF differ"
echo y > "$T/emu/IMG_SHA256"
assert_fails "different test binaries are refused" python3 "$EQ/compare.py" "$T/emu" "$T/ref"

group "wiring"
assert_ok "gen-inner.sh parses" bash -n "$EQ/gen-inner.sh"
assert_ok "emulation-equivalence.sh parses" bash -n "$RELEASE/emulation-equivalence.sh"
assert_ok "workflow passes the dispatch input through env, not into the script" \
  bash -c "! grep -q 'run:.*inputs\.' '$ROOT/.github/workflows/x86-reference.yml' && ! grep -qE '^\s+if .*\\\$\{\{' '$ROOT/.github/workflows/x86-reference.yml'"
assert_ok "emu and ref pin the same v86_64 commit (one place)" grep -qE '^V86_COMMIT=\$\{V86_COMMIT:-[0-9a-f]{40}\}' "$RELEASE/emulation-equivalence.sh"

summary
