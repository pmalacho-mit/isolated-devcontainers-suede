# gdb Python: `x87-print-st N` prints stN the way x86 gdb's
#   printf "    %.100e,\n", $stN
# does, but from the register's raw 80 bits.
#
# Why: on an x86 host gdb hands the 80-bit value straight to glibc's printf
# (host long double is the same format), so every bit pattern prints. On an
# aarch64 host gdb converts it first and refuses encodings that are not valid
# floats -- the pseudo-NaNs and unnormals that MMX writes leave in st0-7 --
# with "Invalid floating value found in program", which aborts the fixture.
# Here the value is decoded exactly and formatted with glibc's rules:
# round-half-even to 100 decimals, `inf`, and `nan` for NaNs, pseudo-NaNs,
# pseudo-infinities and unnormals (glibc >= 2.33, BZ #26649), signed.
import re
from decimal import Decimal, localcontext, ROUND_HALF_EVEN

import gdb


def fmt(raw):
    sign = "-" if raw >> 79 & 1 else ""
    exp = raw >> 64 & 0x7FFF
    man = raw & (1 << 64) - 1
    integer_bit = man >> 63
    if exp == 0x7FFF:
        return sign + ("inf" if integer_bit and man & ((1 << 63) - 1) == 0 else "nan")
    if exp != 0 and not integer_bit:
        return sign + "nan"  # unnormal
    if exp == 0:
        man &= (1 << 63) - 1  # glibc ignores a pseudo-denormal's integer bit
    if man == 0:
        return sign + "0." + "0" * 100 + "e+00"
    with localcontext() as ctx:
        ctx.prec = 20000  # 2**-16445 is exact in ~11.5k digits
        ctx.rounding = ROUND_HALF_EVEN
        v = Decimal(man) * Decimal(2) ** ((exp or 1) - 16383 - 63)
        mant, e = format(v, ".100e").split("e")
    e = int(e)
    return f"{sign}{mant}e{'-' if e < 0 else '+'}{abs(e):02d}"


class X87PrintSt(gdb.Command):
    def __init__(self):
        super().__init__("x87-print-st", gdb.COMMAND_DATA)

    def invoke(self, arg, from_tty):
        out = gdb.execute(f"info registers st{int(arg)}", to_string=True)
        raw = int(re.search(r"\(raw 0x([0-9a-f]+)\)", out).group(1), 16)
        gdb.write(f"    {fmt(raw)},\n")


X87PrintSt()
