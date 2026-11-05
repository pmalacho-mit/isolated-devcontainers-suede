#!/usr/bin/env python3
"""Compare v86_64 nasm fixtures: emulated run vs one or more real-x86 references.

    compare.py EMU_DIR REF_DIR [REF_DIR ...] [--json OUT.json]

Each directory is the output of `emulation-equivalence.sh gen`. For every test,
emulated vs each reference, two verdicts:

  runner  -- what v86_64's tests/nasm/run.js would conclude if the emulated
             fixture were used in place of the reference: the same exception
             detection, the same 1e-7 x87 tolerance, `invalid` skipping,
             MMX-instead-of-x87 when the tag word is all-empty, and the same
             EFLAGS / FPU status masks. This decides whether emulated fixtures
             are usable for v86_64.
  raw     -- byte-for-byte on the raw register bits gdb reports (80-bit x87
             values as `(raw 0x...)`, unmasked EFLAGS and status word) and the
             8 KiB memory window. The issue's stricter bar.

References are also compared with each other: a test on which two real CPUs
disagree is hardware-dependent, and an emulator cannot be held to it.
"""
import json, math, re, sys
from pathlib import Path

MASK_ARITH = 1 | 1 << 2 | 1 << 4 | 1 << 6 | 1 << 7 | 1 << 11
FPU_TAG_ALL_INVALID = 0xAAAA
FPU_STATUS_MASK = 0xFFFF & ~(1 << 9 | 1 << 5 | 1 << 3 | 1 << 1)
EPS = 10 ** -7
JSON_RE = re.compile(r"---BEGIN JSON---([\s\[\]\.\+\w\":\-,]*)---END JSON---")
RAW_RE = re.compile(r"---BEGIN RAW---\n(.*?)---END RAW---", re.S)
FLAGS = {0: "CF", 2: "PF", 4: "AF", 6: "ZF", 7: "SF", 8: "TF", 9: "IF", 10: "DF", 11: "OF"}
FSW = {0: "IE", 1: "DE", 2: "ZE", 3: "OE", 4: "UE", 5: "PE", 6: "SF", 7: "ES", 8: "C0", 9: "C1", 10: "C2", 14: "C3"}


def bits(v, names):
    return ",".join(n for b, n in names.items() if v >> b & 1) or "-"


def exception_of(text):
    exc = None
    for sig, name in (("SIGFPE", "DE"), ("SIGILL", "UD"), ("SIGSEGV", "GP"), ("SIGBUS", "PF")):
        if f"(signal {sig})" in text:
            exc = name
    return exc


def to_float(x):
    if x == "invalid":
        return x
    return {"+INFINITY": math.inf, "-INFINITY": -math.inf, "+NAN": math.nan, "-NAN": math.nan}.get(x, x)


def parse_raw(block):
    """`info registers r` lines -> {r: exact value}; x87 regs by their raw bits."""
    out = {}
    for line in block.splitlines():
        m = re.match(r"(xmm\d) \$\d+ = (\{.*\})", line)
        if m:
            out[m.group(1)] = m.group(2).replace(" ", "")
            continue
        parts = line.split()
        if not parts:
            continue
        raw = re.search(r"\(raw (0x[0-9a-f]+)\)", line)
        out[parts[0]] = raw.group(1) if raw else parts[1]
    return out


def load(path):
    text = path.read_text(errors="replace")
    exc = exception_of(text)
    if not exc and "Program received signal" in text:
        return {"error": "killed during execution by gdb"}
    t = re.sub(r"-inf\b", '"-INFINITY"', text)
    t = re.sub(r"\binf\b", '"+INFINITY"', t)
    t = re.sub(r"-nan\b", '"-NAN"', t)
    t = re.sub(r"\bnan\b", '"+NAN"', t)
    m = JSON_RE.search(t)
    if not m:
        return {"error": "no JSON in fixture"}
    a = json.loads(m.group(1))
    if len(a) != 8 + 1 + 8 + 16 + 32 + 2048 + 3:
        return {"error": f"bad fixture length {len(a)}"}
    o = 0
    f = {"exc": exc}
    f["reg"] = a[o:o + 8]; o += 8
    f["eip"] = a[o]; o += 1
    f["st"] = [to_float(x) for x in a[o:o + 8]]; o += 8
    f["mmx"] = a[o:o + 16]; o += 16
    f["xmm"] = a[o:o + 32]; o += 32
    f["mem"] = a[o:o + 2048]; o += 2048
    f["eflags"], f["ftag"], f["fstat"] = a[o:o + 3]
    r = RAW_RE.search(text)
    f["raw"] = parse_raw(r.group(1)) if r else None
    return f


def feq(x, y):
    if x == y or (isinstance(x, float) and isinstance(y, float) and math.isnan(x) and math.isnan(y)):
        return True
    return abs(x - y) < EPS


def runner_diff(act, exp):
    """run.js finish_test(), with `act` in the emulator's place."""
    d = []
    if not exp["exc"]:
        d += [f"reg32[{i}]" for i in range(8) if act["reg"][i] != exp["reg"][i]]
        if exp["ftag"] != FPU_TAG_ALL_INVALID:
            for i in range(8):
                e, a = exp["st"][i], act["st"][i]
                if e != "invalid" and (a == "invalid" or not feq(a, e)):
                    d.append(f"st{i}: {e!r} vs {a!r}")
            if exp["fstat"] & FPU_STATUS_MASK != act["fstat"] & FPU_STATUS_MASK:
                d.append(f"fpu status (masked): {bits(exp['fstat'] & FPU_STATUS_MASK, FSW)} vs {bits(act['fstat'] & FPU_STATUS_MASK, FSW)}")
        else:
            d += [f"mmx[{i}]" for i in range(16) if act["mmx"][i] != exp["mmx"][i]]
        d += [f"xmm[{i}]" for i in range(32) if act["xmm"][i] != exp["xmm"][i]]
        nm = sum(1 for i in range(2048) if act["mem"][i] != exp["mem"][i])
        if nm:
            d.append(f"memory: {nm} words")
        if exp["eflags"] & MASK_ARITH != act["eflags"] & MASK_ARITH:
            x = (exp["eflags"] ^ act["eflags"]) & MASK_ARITH
            d.append(f"eflags: {bits(x, FLAGS)} differ ({bits(exp['eflags'] & MASK_ARITH, FLAGS)} vs {bits(act['eflags'] & MASK_ARITH, FLAGS)})")
    else:
        if act["eip"] != exp["eip"]:
            d.append(f"exception eip {exp['eip']:#x} vs {act['eip']:#x}")
    if exp["exc"] != act["exc"]:
        d.append(f"exception {exp['exc']} vs {act['exc']}")
    return d


def raw_diff(act, exp):
    d = []
    if act["exc"] != exp["exc"]:
        d.append(f"exception {exp['exc']} vs {act['exc']}")
    if act["raw"] is None or exp["raw"] is None:
        return d + ["(no raw dump)"]
    for k in exp["raw"]:
        if exp["raw"][k] != act["raw"].get(k):
            if k == "eflags":
                x = int(exp["raw"][k], 16) ^ int(act["raw"][k], 16)
                d.append(f"eflags: {bits(x, FLAGS)}")
            elif k == "fstat":
                x = int(exp["raw"][k], 16) ^ int(act["raw"][k], 16)
                d.append(f"fstat: {bits(x, FSW)}")
            else:
                d.append(f"{k}: {exp['raw'][k]} vs {act['raw'].get(k)}")
    nm = sum(1 for i in range(2048) if act["mem"][i] != exp["mem"][i])
    if nm:
        d.append(f"memory: {nm} words")
    return d


def trace_steps(path):
    steps = re.split(r"---STEP \d+---\n", path.read_text(errors="replace"))[1:]
    return [parse_raw(s.split("---END TRACE")[0]) for s in steps]


def trace_diff(act_dir, exp_dir, name):
    a, e = trace_steps(act_dir / f"{name}.trace"), trace_steps(exp_dir / f"{name}.trace")
    if len(a) != len(e):
        return [f"{len(e)} steps vs {len(a)}"]
    for i, (sa, se) in enumerate(zip(a, e)):
        diff = [k for k in se if se[k] != sa.get(k)]
        if diff:
            return [f"step {i} (eip {se.get('eip')}): " + ", ".join(f"{k} {se[k]} vs {sa.get(k)}" for k in diff)]
    return []


def compare(act_dir, exp_dir):
    res = {}
    for p in sorted(exp_dir.glob("*.fixture")):
        name = p.stem
        q = act_dir / p.name
        if not q.exists():
            res[name] = {"missing": True}
            continue
        e, a = load(p), load(q)
        if "error" in e or "error" in a:
            res[name] = {"error": f"ref: {e.get('error')}; other: {a.get('error')}"}
            continue
        res[name] = {"runner": runner_diff(a, e), "raw": raw_diff(a, e)}
    traces = {p.stem: trace_diff(act_dir, exp_dir, p.stem) for p in sorted(exp_dir.glob("*.trace"))}
    return res, traces


def toolchain(d):
    return (d / "TOOLCHAIN").read_text().strip()


def main():
    args = sys.argv[1:]
    jout = None
    if "--json" in args:
        i = args.index("--json"); jout = args[i + 1]; del args[i:i + 2]
    if len(args) < 2:
        sys.exit(__doc__)
    emu, refs = Path(args[0]), [Path(a) for a in args[1:]]

    # Same inputs, or the comparison means nothing.
    want = (refs[0] / "IMG_SHA256").read_text()
    for d in [emu] + refs[1:]:
        if (d / "IMG_SHA256").read_text() != want:
            sys.exit(f"REFUSED: {d} built different test binaries from {refs[0]} (IMG_SHA256 differ)")

    report = {"toolchains": {str(d): toolchain(d) for d in [emu] + refs}, "vs_ref": {}, "ref_vs_ref": {}}
    print("## Toolchains\n")
    for d in [emu] + refs:
        print(f"### {d}\n```\n{toolchain(d)}\n```")

    hw_dependent = set()
    for i, r1 in enumerate(refs):
        for r2 in refs[i + 1:]:
            res, tr = compare(r2, r1)
            raw = {n: v["raw"] for n, v in res.items() if v.get("raw")}
            hw_dependent |= set(raw)
            report["ref_vs_ref"][f"{r1} vs {r2}"] = {"raw": raw, "runner": {n: v["runner"] for n, v in res.items() if v.get("runner")}, "traces": {n: t for n, t in tr.items() if t}}
            print(f"\n## Real CPUs: {r1} vs {r2}\n")
            print(f"{len(res)} tests; raw differences in {len(raw)}; runner-visible in {sum(1 for v in res.values() if v.get('runner'))}")
            for n, d in raw.items():
                print(f"- `{n}`: {'; '.join(d)}")
            for n, t in tr.items():
                if t:
                    print(f"- trace `{n}`: {t[0]}")

    for r in refs:
        res, tr = compare(emu, r)
        report["vs_ref"][str(r)] = {"results": res, "traces": tr}
        n = len(res)
        bad = {k: v for k, v in res.items() if "missing" in v or "error" in v}
        run_f = {k: v["runner"] for k, v in res.items() if v.get("runner")}
        raw_f = {k: v["raw"] for k, v in res.items() if v.get("raw")}
        print(f"\n## Emulated vs {r}\n")
        print(f"{n} tests. runner verdict: {n - len(run_f) - len(bad)} pass, {len(run_f)} fail. "
              f"raw: {n - len(raw_f) - len(bad)} identical, {len(raw_f)} differ "
              f"({len(set(raw_f) & hw_dependent)} of them also differ between real CPUs). "
              f"{len(bad)} missing/broken.")
        for k, v in bad.items():
            print(f"- BROKEN `{k}`: {v}")
        if run_f:
            print("\n### Runner-visible (v86_64 would notice)")
            for k, d in run_f.items():
                print(f"- `{k}`{' (hw-dependent)' if k in hw_dependent else ''}: {'; '.join(d)}")
        only_raw = {k: d for k, d in raw_f.items() if k not in run_f}
        if only_raw:
            print("\n### Raw only (below run.js's tolerance or masks)")
            for k, d in only_raw.items():
                print(f"- `{k}`{' (hw-dependent)' if k in hw_dependent else ''}: {'; '.join(d)}")
        print("\n### gdb single-step traces")
        for k, t in tr.items():
            print(f"- `{k}`: {'identical' if not t else t[0]}")

    if jout:
        Path(jout).write_text(json.dumps(report, indent=1, default=str))


if __name__ == "__main__":
    main()
