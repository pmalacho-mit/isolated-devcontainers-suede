# x86 emulation equivalence evidence (issue #37)

Is `docker run --platform linux/386` (or `linux/amd64`) on the aarch64 VM equivalent to real x86 for v86_64's nasm test fixtures? **No, not in general.** It is equivalent for integer, SSE and ordinary x87 arithmetic. It is not equivalent for x87 stack faults, a few instruction encodings, and the precision of `fsin`/`fcos`/`fptan`/`fsincos`. Every difference is listed below with its cause; none is unexplained.

Produced with `release/emulation-equivalence.sh` (method in [x86-emulation.md](x86-emulation.md)). The full per-test report (`compare` output, 12 MB) and the three fixture sets are attached to the PR, not committed.

## Inputs

| | Intel reference | AMD reference | Emulated |
|---|---|---|---|
| CPU | Xeon Gold 6140 (Skylake-SP, family 6 model 85 stepping 4), Hyper-V guest | EPYC 9V74 (Zen 4, family 25), GitHub `ubuntu-latest` | aarch64 Colima VM, `qemu-i386-static` 8.2.2 (`1:8.2.2+ds-0ubuntu1.18`, the VM's) |
| How | native gdb 15.1, ptrace | native gdb 15.1, ptrace | `qemu-i386-static -g` + aarch64 `gdb-multiarch` 15.1 |

All three: v86_64 `c394574477b57eadfc859f593b4aecb08fa37cb6`, `ubuntu:24.04`, nasm 2.16.01, ld 2.42, node 18.19.1. **16,529 tests**, and all three built byte-identical test binaries (`IMG_SHA256`).

## Result

| Comparison | v86_64 `run.js` rules | Raw register bits |
|---|---|---|
| Intel vs AMD | 16,529 / 16,529 agree | **16,529 / 16,529 identical** |
| Emulated vs either | 15,491 pass, **1,038 fail** | 1,689 identical, 14,840 differ |

The two real CPUs agree bit for bit on every fixture, including the x87 transcendentals. Their gdb single-step traces also match, except for one C1 bit midway through `f2xm1` (Intel `0x3020`, AMD `0x3220`), which is overwritten before the end. So nothing below is excused as "hardware-dependent": every difference is qemu's.

"`run.js` rules" means: what v86_64's own runner would conclude with the emulated fixture as the expected value. That is a 1e-7 absolute x87 tolerance, `invalid` slots skipped, EFLAGS masked to CF/PF/AF/ZF/SF/OF, the FPU status word with C1/PE/UE/DE masked, and only the exception type and `eip` for exception tests.

## Differences v86_64's runner would see (1,038)

| Cause | Tests | Real x86 | qemu 8.2.2 |
|---|---|---|---|
| x87 stack fault | 920 | Register-stack overflow/underflow sets IE+SF, loads the QNaN indefinite, and compares report "unordered" (C0=C2=C3=1; ZF=PF=CF=1 for `FCOMI`). Real hardware faulted in exactly these 920 of the 3,345 generated x87 tests. | Never reports a stack fault: it computes with whatever the empty register holds. |
| `FCOMI`/`FUCOMI`/`FCOMIP`/`FUCOMIP` flags | 56 | Sets ZF/PF/CF and **clears** OF, SF, AF (as the SDM specifies). | Leaves OF/SF/AF as they were. |
| `F6 /1`, `F7 /1` | 30 | Undocumented alias of `TEST`; executes. | #UD. |
| Register form of `MOVNTQ` (`0F E7`), `MOVNTDQ` (`66 0F E7`), `MOVLPD` (`66 0F 12`), `MOVHPD` (`66 0F 16`) | 20 | #UD (memory-only instructions). | Executes. |
| 16-bit `ENTER` (`C8`) | 5 | Writes BP only; the upper half of EBP is kept. | Writes all of EBP. |
| `0F 18` (hint NOPs) | 3 | NOP for these ModRM forms. | #UD. |
| `fprem`, `fprem1` after an invalid operation | 2 | C3 set. | C3 clear (qemu rewrites C0–C3 from the quotient). |
| `FSAVE` (32-bit format) | 1 | Reserved upper 16 bits of the control, status and tag word and of the operand selector stored as `0xffff`. | Stored as `0`. |
| `fyl2xp1` outside \|x\| < 1−√2/2 | 1 | Computes a value (2.0502 here); the SDM calls the result undefined. | Raises IE, returns NaN. |

### x87-stack-fault (920)

By opcode: `D8 /0` 20, `D8 /1` 20, `D8 /2` 20, `D8 /3` 20, `D8 /4` 20, `D8 /5` 20, `D8 /6` 20, `D8 /7` 20, `D9 /0` 40, `D9 /1` 40, `DA /0` 20, `DA /1` 20, `DA /2` 20, `DA /3` 20, `DB /0` 20, `DB /1` 20, `DB /2` 20, `DB /3` 20, `DB /5` 20, `DB /6` 20, `DC /0` 20, `DC /1` 20, `DC /2` 20, `DC /3` 20, `DC /4` 20, `DC /5` 20, `DC /6` 20, `DC /7` 20, `DD /1` 40, `DD /4` 40, `DD /5` 40, `DE /0` 20, `DE /1` 20, `DE /2` 20, `DE /4` 20, `DE /5` 20, `DE /6` 20, `DE /7` 20, `DF /1` 20, `DF /5` 20, `DF /6` 20

<details><summary>tests</summary>

`gen_d8_0_12` `gen_d8_0_13` `gen_d8_0_14` `gen_d8_0_15` `gen_d8_0_20` `gen_d8_0_21` `gen_d8_0_22` `gen_d8_0_23` `gen_d8_0_28` `gen_d8_0_29` `gen_d8_0_30` `gen_d8_0_31` `gen_d8_0_36` `gen_d8_0_37` `gen_d8_0_38` `gen_d8_0_39` `gen_d8_0_4` `gen_d8_0_5` `gen_d8_0_6` `gen_d8_0_7` `gen_d8_1_12` `gen_d8_1_13` `gen_d8_1_14` `gen_d8_1_15` `gen_d8_1_20` `gen_d8_1_21` `gen_d8_1_22` `gen_d8_1_23` `gen_d8_1_28` `gen_d8_1_29` `gen_d8_1_30` `gen_d8_1_31` `gen_d8_1_36` `gen_d8_1_37` `gen_d8_1_38` `gen_d8_1_39` `gen_d8_1_4` `gen_d8_1_5` `gen_d8_1_6` `gen_d8_1_7` `gen_d8_2_12` `gen_d8_2_13` `gen_d8_2_14` `gen_d8_2_15` `gen_d8_2_20` `gen_d8_2_21` `gen_d8_2_22` `gen_d8_2_23` `gen_d8_2_28` `gen_d8_2_29` `gen_d8_2_30` `gen_d8_2_31` `gen_d8_2_36` `gen_d8_2_37` `gen_d8_2_38` `gen_d8_2_39` `gen_d8_2_4` `gen_d8_2_5` `gen_d8_2_6` `gen_d8_2_7` `gen_d8_3_12` `gen_d8_3_13` `gen_d8_3_14` `gen_d8_3_15` `gen_d8_3_20` `gen_d8_3_21` `gen_d8_3_22` `gen_d8_3_23` `gen_d8_3_28` `gen_d8_3_29` `gen_d8_3_30` `gen_d8_3_31` `gen_d8_3_36` `gen_d8_3_37` `gen_d8_3_38` `gen_d8_3_39` `gen_d8_3_4` `gen_d8_3_5` `gen_d8_3_6` `gen_d8_3_7` `gen_d8_4_12` `gen_d8_4_13` `gen_d8_4_14` `gen_d8_4_15` `gen_d8_4_20` `gen_d8_4_21` `gen_d8_4_22` `gen_d8_4_23` `gen_d8_4_28` `gen_d8_4_29` `gen_d8_4_30` `gen_d8_4_31` `gen_d8_4_36` `gen_d8_4_37` `gen_d8_4_38` `gen_d8_4_39` `gen_d8_4_4` `gen_d8_4_5` `gen_d8_4_6` `gen_d8_4_7` `gen_d8_5_12` `gen_d8_5_13` `gen_d8_5_14` `gen_d8_5_15` `gen_d8_5_20` `gen_d8_5_21` `gen_d8_5_22` `gen_d8_5_23` `gen_d8_5_28` `gen_d8_5_29` `gen_d8_5_30` `gen_d8_5_31` `gen_d8_5_36` `gen_d8_5_37` `gen_d8_5_38` `gen_d8_5_39` `gen_d8_5_4` `gen_d8_5_5` `gen_d8_5_6` `gen_d8_5_7` `gen_d8_6_12` `gen_d8_6_13` `gen_d8_6_14` `gen_d8_6_15` `gen_d8_6_20` `gen_d8_6_21` `gen_d8_6_22` `gen_d8_6_23` `gen_d8_6_28` `gen_d8_6_29` `gen_d8_6_30` `gen_d8_6_31` `gen_d8_6_36` `gen_d8_6_37` `gen_d8_6_38` `gen_d8_6_39` `gen_d8_6_4` `gen_d8_6_5` `gen_d8_6_6` `gen_d8_6_7` `gen_d8_7_12` `gen_d8_7_13` `gen_d8_7_14` `gen_d8_7_15` `gen_d8_7_20` `gen_d8_7_21` `gen_d8_7_22` `gen_d8_7_23` `gen_d8_7_28` `gen_d8_7_29` `gen_d8_7_30` `gen_d8_7_31` `gen_d8_7_36` `gen_d8_7_37` `gen_d8_7_38` `gen_d8_7_39` `gen_d8_7_4` `gen_d8_7_5` `gen_d8_7_6` `gen_d8_7_7` `gen_d9_0_12` `gen_d9_0_13` `gen_d9_0_14` `gen_d9_0_15` `gen_d9_0_20` `gen_d9_0_21` `gen_d9_0_22` `gen_d9_0_23` `gen_d9_0_28` `gen_d9_0_29` `gen_d9_0_30` `gen_d9_0_31` `gen_d9_0_36` `gen_d9_0_37` `gen_d9_0_38` `gen_d9_0_39` `gen_d9_0_4` `gen_d9_0_44` `gen_d9_0_45` `gen_d9_0_46` `gen_d9_0_47` `gen_d9_0_5` `gen_d9_0_52` `gen_d9_0_53` `gen_d9_0_54` `gen_d9_0_55` `gen_d9_0_6` `gen_d9_0_60` `gen_d9_0_61` `gen_d9_0_62` `gen_d9_0_63` `gen_d9_0_68` `gen_d9_0_69` `gen_d9_0_7` `gen_d9_0_70` `gen_d9_0_71` `gen_d9_0_76` `gen_d9_0_77` `gen_d9_0_78` `gen_d9_0_79` `gen_d9_1_12` `gen_d9_1_13` `gen_d9_1_14` `gen_d9_1_15` `gen_d9_1_20` `gen_d9_1_21` `gen_d9_1_22` `gen_d9_1_23` `gen_d9_1_28` `gen_d9_1_29` `gen_d9_1_30` `gen_d9_1_31` `gen_d9_1_36` `gen_d9_1_37` `gen_d9_1_38` `gen_d9_1_39` `gen_d9_1_4` `gen_d9_1_44` `gen_d9_1_45` `gen_d9_1_46` `gen_d9_1_47` `gen_d9_1_5` `gen_d9_1_52` `gen_d9_1_53` `gen_d9_1_54` `gen_d9_1_55` `gen_d9_1_6` `gen_d9_1_60` `gen_d9_1_61` `gen_d9_1_62` `gen_d9_1_63` `gen_d9_1_68` `gen_d9_1_69` `gen_d9_1_7` `gen_d9_1_70` `gen_d9_1_71` `gen_d9_1_76` `gen_d9_1_77` `gen_d9_1_78` `gen_d9_1_79` `gen_da_0_12` `gen_da_0_13` `gen_da_0_14` `gen_da_0_15` `gen_da_0_20` `gen_da_0_21` `gen_da_0_22` `gen_da_0_23` `gen_da_0_28` `gen_da_0_29` `gen_da_0_30` `gen_da_0_31` `gen_da_0_36` `gen_da_0_37` `gen_da_0_38` `gen_da_0_39` `gen_da_0_4` `gen_da_0_5` `gen_da_0_6` `gen_da_0_7` `gen_da_1_12` `gen_da_1_13` `gen_da_1_14` `gen_da_1_15` `gen_da_1_20` `gen_da_1_21` `gen_da_1_22` `gen_da_1_23` `gen_da_1_28` `gen_da_1_29` `gen_da_1_30` `gen_da_1_31` `gen_da_1_36` `gen_da_1_37` `gen_da_1_38` `gen_da_1_39` `gen_da_1_4` `gen_da_1_5` `gen_da_1_6` `gen_da_1_7` `gen_da_2_12` `gen_da_2_13` `gen_da_2_14` `gen_da_2_15` `gen_da_2_20` `gen_da_2_21` `gen_da_2_22` `gen_da_2_23` `gen_da_2_28` `gen_da_2_29` `gen_da_2_30` `gen_da_2_31` `gen_da_2_36` `gen_da_2_37` `gen_da_2_38` `gen_da_2_39` `gen_da_2_4` `gen_da_2_5` `gen_da_2_6` `gen_da_2_7` `gen_da_3_12` `gen_da_3_13` `gen_da_3_14` `gen_da_3_15` `gen_da_3_20` `gen_da_3_21` `gen_da_3_22` `gen_da_3_23` `gen_da_3_28` `gen_da_3_29` `gen_da_3_30` `gen_da_3_31` `gen_da_3_36` `gen_da_3_37` `gen_da_3_38` `gen_da_3_39` `gen_da_3_4` `gen_da_3_5` `gen_da_3_6` `gen_da_3_7` `gen_db_0_12` `gen_db_0_13` `gen_db_0_14` `gen_db_0_15` `gen_db_0_20` `gen_db_0_21` `gen_db_0_22` `gen_db_0_23` `gen_db_0_28` `gen_db_0_29` `gen_db_0_30` `gen_db_0_31` `gen_db_0_36` `gen_db_0_37` `gen_db_0_38` `gen_db_0_39` `gen_db_0_4` `gen_db_0_5` `gen_db_0_6` `gen_db_0_7` `gen_db_1_12` `gen_db_1_13` `gen_db_1_14` `gen_db_1_15` `gen_db_1_20` `gen_db_1_21` `gen_db_1_22` `gen_db_1_23` `gen_db_1_28` `gen_db_1_29` `gen_db_1_30` `gen_db_1_31` `gen_db_1_36` `gen_db_1_37` `gen_db_1_38` `gen_db_1_39` `gen_db_1_4` `gen_db_1_5` `gen_db_1_6` `gen_db_1_7` `gen_db_2_12` `gen_db_2_13` `gen_db_2_14` `gen_db_2_15` `gen_db_2_20` `gen_db_2_21` `gen_db_2_22` `gen_db_2_23` `gen_db_2_28` `gen_db_2_29` `gen_db_2_30` `gen_db_2_31` `gen_db_2_36` `gen_db_2_37` `gen_db_2_38` `gen_db_2_39` `gen_db_2_4` `gen_db_2_5` `gen_db_2_6` `gen_db_2_7` `gen_db_3_12` `gen_db_3_13` `gen_db_3_14` `gen_db_3_15` `gen_db_3_20` `gen_db_3_21` `gen_db_3_22` `gen_db_3_23` `gen_db_3_28` `gen_db_3_29` `gen_db_3_30` `gen_db_3_31` `gen_db_3_36` `gen_db_3_37` `gen_db_3_38` `gen_db_3_39` `gen_db_3_4` `gen_db_3_5` `gen_db_3_6` `gen_db_3_7` `gen_db_5_12` `gen_db_5_13` `gen_db_5_14` `gen_db_5_15` `gen_db_5_20` `gen_db_5_21` `gen_db_5_22` `gen_db_5_23` `gen_db_5_28` `gen_db_5_29` `gen_db_5_30` `gen_db_5_31` `gen_db_5_36` `gen_db_5_37` `gen_db_5_38` `gen_db_5_39` `gen_db_5_4` `gen_db_5_5` `gen_db_5_6` `gen_db_5_7` `gen_db_6_12` `gen_db_6_13` `gen_db_6_14` `gen_db_6_15` `gen_db_6_20` `gen_db_6_21` `gen_db_6_22` `gen_db_6_23` `gen_db_6_28` `gen_db_6_29` `gen_db_6_30` `gen_db_6_31` `gen_db_6_36` `gen_db_6_37` `gen_db_6_38` `gen_db_6_39` `gen_db_6_4` `gen_db_6_5` `gen_db_6_6` `gen_db_6_7` `gen_dc_0_12` `gen_dc_0_13` `gen_dc_0_14` `gen_dc_0_15` `gen_dc_0_20` `gen_dc_0_21` `gen_dc_0_22` `gen_dc_0_23` `gen_dc_0_28` `gen_dc_0_29` `gen_dc_0_30` `gen_dc_0_31` `gen_dc_0_36` `gen_dc_0_37` `gen_dc_0_38` `gen_dc_0_39` `gen_dc_0_4` `gen_dc_0_5` `gen_dc_0_6` `gen_dc_0_7` `gen_dc_1_12` `gen_dc_1_13` `gen_dc_1_14` `gen_dc_1_15` `gen_dc_1_20` `gen_dc_1_21` `gen_dc_1_22` `gen_dc_1_23` `gen_dc_1_28` `gen_dc_1_29` `gen_dc_1_30` `gen_dc_1_31` `gen_dc_1_36` `gen_dc_1_37` `gen_dc_1_38` `gen_dc_1_39` `gen_dc_1_4` `gen_dc_1_5` `gen_dc_1_6` `gen_dc_1_7` `gen_dc_2_12` `gen_dc_2_13` `gen_dc_2_14` `gen_dc_2_15` `gen_dc_2_20` `gen_dc_2_21` `gen_dc_2_22` `gen_dc_2_23` `gen_dc_2_28` `gen_dc_2_29` `gen_dc_2_30` `gen_dc_2_31` `gen_dc_2_36` `gen_dc_2_37` `gen_dc_2_38` `gen_dc_2_39` `gen_dc_2_4` `gen_dc_2_5` `gen_dc_2_6` `gen_dc_2_7` `gen_dc_3_12` `gen_dc_3_13` `gen_dc_3_14` `gen_dc_3_15` `gen_dc_3_20` `gen_dc_3_21` `gen_dc_3_22` `gen_dc_3_23` `gen_dc_3_28` `gen_dc_3_29` `gen_dc_3_30` `gen_dc_3_31` `gen_dc_3_36` `gen_dc_3_37` `gen_dc_3_38` `gen_dc_3_39` `gen_dc_3_4` `gen_dc_3_5` `gen_dc_3_6` `gen_dc_3_7` `gen_dc_4_12` `gen_dc_4_13` `gen_dc_4_14` `gen_dc_4_15` `gen_dc_4_20` `gen_dc_4_21` `gen_dc_4_22` `gen_dc_4_23` `gen_dc_4_28` `gen_dc_4_29` `gen_dc_4_30` `gen_dc_4_31` `gen_dc_4_36` `gen_dc_4_37` `gen_dc_4_38` `gen_dc_4_39` `gen_dc_4_4` `gen_dc_4_5` `gen_dc_4_6` `gen_dc_4_7` `gen_dc_5_12` `gen_dc_5_13` `gen_dc_5_14` `gen_dc_5_15` `gen_dc_5_20` `gen_dc_5_21` `gen_dc_5_22` `gen_dc_5_23` `gen_dc_5_28` `gen_dc_5_29` `gen_dc_5_30` `gen_dc_5_31` `gen_dc_5_36` `gen_dc_5_37` `gen_dc_5_38` `gen_dc_5_39` `gen_dc_5_4` `gen_dc_5_5` `gen_dc_5_6` `gen_dc_5_7` `gen_dc_6_12` `gen_dc_6_13` `gen_dc_6_14` `gen_dc_6_15` `gen_dc_6_20` `gen_dc_6_21` `gen_dc_6_22` `gen_dc_6_23` `gen_dc_6_28` `gen_dc_6_29` `gen_dc_6_30` `gen_dc_6_31` `gen_dc_6_36` `gen_dc_6_37` `gen_dc_6_38` `gen_dc_6_39` `gen_dc_6_4` `gen_dc_6_5` `gen_dc_6_6` `gen_dc_6_7` `gen_dc_7_12` `gen_dc_7_13` `gen_dc_7_14` `gen_dc_7_15` `gen_dc_7_20` `gen_dc_7_21` `gen_dc_7_22` `gen_dc_7_23` `gen_dc_7_28` `gen_dc_7_29` `gen_dc_7_30` `gen_dc_7_31` `gen_dc_7_36` `gen_dc_7_37` `gen_dc_7_38` `gen_dc_7_39` `gen_dc_7_4` `gen_dc_7_5` `gen_dc_7_6` `gen_dc_7_7` `gen_dd_1_12` `gen_dd_1_13` `gen_dd_1_14` `gen_dd_1_15` `gen_dd_1_20` `gen_dd_1_21` `gen_dd_1_22` `gen_dd_1_23` `gen_dd_1_28` `gen_dd_1_29` `gen_dd_1_30` `gen_dd_1_31` `gen_dd_1_36` `gen_dd_1_37` `gen_dd_1_38` `gen_dd_1_39` `gen_dd_1_4` `gen_dd_1_44` `gen_dd_1_45` `gen_dd_1_46` `gen_dd_1_47` `gen_dd_1_5` `gen_dd_1_52` `gen_dd_1_53` `gen_dd_1_54` `gen_dd_1_55` `gen_dd_1_6` `gen_dd_1_60` `gen_dd_1_61` `gen_dd_1_62` `gen_dd_1_63` `gen_dd_1_68` `gen_dd_1_69` `gen_dd_1_7` `gen_dd_1_70` `gen_dd_1_71` `gen_dd_1_76` `gen_dd_1_77` `gen_dd_1_78` `gen_dd_1_79` `gen_dd_4_12` `gen_dd_4_13` `gen_dd_4_14` `gen_dd_4_15` `gen_dd_4_20` `gen_dd_4_21` `gen_dd_4_22` `gen_dd_4_23` `gen_dd_4_28` `gen_dd_4_29` `gen_dd_4_30` `gen_dd_4_31` `gen_dd_4_36` `gen_dd_4_37` `gen_dd_4_38` `gen_dd_4_39` `gen_dd_4_4` `gen_dd_4_44` `gen_dd_4_45` `gen_dd_4_46` `gen_dd_4_47` `gen_dd_4_5` `gen_dd_4_52` `gen_dd_4_53` `gen_dd_4_54` `gen_dd_4_55` `gen_dd_4_6` `gen_dd_4_60` `gen_dd_4_61` `gen_dd_4_62` `gen_dd_4_63` `gen_dd_4_68` `gen_dd_4_69` `gen_dd_4_7` `gen_dd_4_70` `gen_dd_4_71` `gen_dd_4_76` `gen_dd_4_77` `gen_dd_4_78` `gen_dd_4_79` `gen_dd_5_12` `gen_dd_5_13` `gen_dd_5_14` `gen_dd_5_15` `gen_dd_5_20` `gen_dd_5_21` `gen_dd_5_22` `gen_dd_5_23` `gen_dd_5_28` `gen_dd_5_29` `gen_dd_5_30` `gen_dd_5_31` `gen_dd_5_36` `gen_dd_5_37` `gen_dd_5_38` `gen_dd_5_39` `gen_dd_5_4` `gen_dd_5_44` `gen_dd_5_45` `gen_dd_5_46` `gen_dd_5_47` `gen_dd_5_5` `gen_dd_5_52` `gen_dd_5_53` `gen_dd_5_54` `gen_dd_5_55` `gen_dd_5_6` `gen_dd_5_60` `gen_dd_5_61` `gen_dd_5_62` `gen_dd_5_63` `gen_dd_5_68` `gen_dd_5_69` `gen_dd_5_7` `gen_dd_5_70` `gen_dd_5_71` `gen_dd_5_76` `gen_dd_5_77` `gen_dd_5_78` `gen_dd_5_79` `gen_de_0_12` `gen_de_0_13` `gen_de_0_14` `gen_de_0_15` `gen_de_0_20` `gen_de_0_21` `gen_de_0_22` `gen_de_0_23` `gen_de_0_28` `gen_de_0_29` `gen_de_0_30` `gen_de_0_31` `gen_de_0_36` `gen_de_0_37` `gen_de_0_38` `gen_de_0_39` `gen_de_0_4` `gen_de_0_5` `gen_de_0_6` `gen_de_0_7` `gen_de_1_12` `gen_de_1_13` `gen_de_1_14` `gen_de_1_15` `gen_de_1_20` `gen_de_1_21` `gen_de_1_22` `gen_de_1_23` `gen_de_1_28` `gen_de_1_29` `gen_de_1_30` `gen_de_1_31` `gen_de_1_36` `gen_de_1_37` `gen_de_1_38` `gen_de_1_39` `gen_de_1_4` `gen_de_1_5` `gen_de_1_6` `gen_de_1_7` `gen_de_2_12` `gen_de_2_13` `gen_de_2_14` `gen_de_2_15` `gen_de_2_20` `gen_de_2_21` `gen_de_2_22` `gen_de_2_23` `gen_de_2_28` `gen_de_2_29` `gen_de_2_30` `gen_de_2_31` `gen_de_2_36` `gen_de_2_37` `gen_de_2_38` `gen_de_2_39` `gen_de_2_4` `gen_de_2_5` `gen_de_2_6` `gen_de_2_7` `gen_de_4_12` `gen_de_4_13` `gen_de_4_14` `gen_de_4_15` `gen_de_4_20` `gen_de_4_21` `gen_de_4_22` `gen_de_4_23` `gen_de_4_28` `gen_de_4_29` `gen_de_4_30` `gen_de_4_31` `gen_de_4_36` `gen_de_4_37` `gen_de_4_38` `gen_de_4_39` `gen_de_4_4` `gen_de_4_5` `gen_de_4_6` `gen_de_4_7` `gen_de_5_12` `gen_de_5_13` `gen_de_5_14` `gen_de_5_15` `gen_de_5_20` `gen_de_5_21` `gen_de_5_22` `gen_de_5_23` `gen_de_5_28` `gen_de_5_29` `gen_de_5_30` `gen_de_5_31` `gen_de_5_36` `gen_de_5_37` `gen_de_5_38` `gen_de_5_39` `gen_de_5_4` `gen_de_5_5` `gen_de_5_6` `gen_de_5_7` `gen_de_6_12` `gen_de_6_13` `gen_de_6_14` `gen_de_6_15` `gen_de_6_20` `gen_de_6_21` `gen_de_6_22` `gen_de_6_23` `gen_de_6_28` `gen_de_6_29` `gen_de_6_30` `gen_de_6_31` `gen_de_6_36` `gen_de_6_37` `gen_de_6_38` `gen_de_6_39` `gen_de_6_4` `gen_de_6_5` `gen_de_6_6` `gen_de_6_7` `gen_de_7_12` `gen_de_7_13` `gen_de_7_14` `gen_de_7_15` `gen_de_7_20` `gen_de_7_21` `gen_de_7_22` `gen_de_7_23` `gen_de_7_28` `gen_de_7_29` `gen_de_7_30` `gen_de_7_31` `gen_de_7_36` `gen_de_7_37` `gen_de_7_38` `gen_de_7_39` `gen_de_7_4` `gen_de_7_5` `gen_de_7_6` `gen_de_7_7` `gen_df_1_12` `gen_df_1_13` `gen_df_1_14` `gen_df_1_15` `gen_df_1_20` `gen_df_1_21` `gen_df_1_22` `gen_df_1_23` `gen_df_1_28` `gen_df_1_29` `gen_df_1_30` `gen_df_1_31` `gen_df_1_36` `gen_df_1_37` `gen_df_1_38` `gen_df_1_39` `gen_df_1_4` `gen_df_1_5` `gen_df_1_6` `gen_df_1_7` `gen_df_5_12` `gen_df_5_13` `gen_df_5_14` `gen_df_5_15` `gen_df_5_20` `gen_df_5_21` `gen_df_5_22` `gen_df_5_23` `gen_df_5_28` `gen_df_5_29` `gen_df_5_30` `gen_df_5_31` `gen_df_5_36` `gen_df_5_37` `gen_df_5_38` `gen_df_5_39` `gen_df_5_4` `gen_df_5_5` `gen_df_5_6` `gen_df_5_7` `gen_df_6_12` `gen_df_6_13` `gen_df_6_14` `gen_df_6_15` `gen_df_6_20` `gen_df_6_21` `gen_df_6_22` `gen_df_6_23` `gen_df_6_28` `gen_df_6_29` `gen_df_6_30` `gen_df_6_31` `gen_df_6_36` `gen_df_6_37` `gen_df_6_38` `gen_df_6_39` `gen_df_6_4` `gen_df_6_5` `gen_df_6_6` `gen_df_6_7`

</details>

### fcomi-flags (56)

By opcode: `DB /5` 8, `DB /6` 8, `DF /5` 20, `DF /6` 20

<details><summary>tests</summary>

`gen_db_5_0` `gen_db_5_1` `gen_db_5_16` `gen_db_5_17` `gen_db_5_18` `gen_db_5_19` `gen_db_5_2` `gen_db_5_3` `gen_db_6_0` `gen_db_6_1` `gen_db_6_16` `gen_db_6_17` `gen_db_6_18` `gen_db_6_19` `gen_db_6_2` `gen_db_6_3` `gen_df_5_0` `gen_df_5_1` `gen_df_5_10` `gen_df_5_11` `gen_df_5_16` `gen_df_5_17` `gen_df_5_18` `gen_df_5_19` `gen_df_5_2` `gen_df_5_24` `gen_df_5_25` `gen_df_5_26` `gen_df_5_27` `gen_df_5_3` `gen_df_5_32` `gen_df_5_33` `gen_df_5_34` `gen_df_5_35` `gen_df_5_8` `gen_df_5_9` `gen_df_6_0` `gen_df_6_1` `gen_df_6_10` `gen_df_6_11` `gen_df_6_16` `gen_df_6_17` `gen_df_6_18` `gen_df_6_19` `gen_df_6_2` `gen_df_6_24` `gen_df_6_25` `gen_df_6_26` `gen_df_6_27` `gen_df_6_3` `gen_df_6_32` `gen_df_6_33` `gen_df_6_34` `gen_df_6_35` `gen_df_6_8` `gen_df_6_9`

</details>

### decode-test-alias (30)

By opcode: `F6 /1` 10, `F7 /1` 20

<details><summary>tests</summary>

`gen_f6_1_0` `gen_f6_1_1` `gen_f6_1_2` `gen_f6_1_3` `gen_f6_1_4` `gen_f6_1_5` `gen_f6_1_6` `gen_f6_1_7` `gen_f6_1_8` `gen_f6_1_9` `gen_f7_1_0` `gen_f7_1_1` `gen_f7_1_10` `gen_f7_1_11` `gen_f7_1_12` `gen_f7_1_13` `gen_f7_1_14` `gen_f7_1_15` `gen_f7_1_16` `gen_f7_1_17` `gen_f7_1_18` `gen_f7_1_19` `gen_f7_1_2` `gen_f7_1_3` `gen_f7_1_4` `gen_f7_1_5` `gen_f7_1_6` `gen_f7_1_7` `gen_f7_1_8` `gen_f7_1_9`

</details>

### decode-regform (20)

By opcode: `0FE7 /0` 5, `660F12 /0` 5, `660F16 /0` 5, `660FE7 /0` 5

<details><summary>tests</summary>

`gen_0fe7_0_0` `gen_0fe7_0_1` `gen_0fe7_0_2` `gen_0fe7_0_3` `gen_0fe7_0_4` `gen_660f12_0_0` `gen_660f12_0_1` `gen_660f12_0_2` `gen_660f12_0_3` `gen_660f12_0_4` `gen_660f16_0_0` `gen_660f16_0_1` `gen_660f16_0_2` `gen_660f16_0_3` `gen_660f16_0_4` `gen_660fe7_0_0` `gen_660fe7_0_1` `gen_660fe7_0_2` `gen_660fe7_0_3` `gen_660fe7_0_4`

</details>

### enter16 (5)

By opcode: `C8 /0` 5

<details><summary>tests</summary>

`gen_c8_0_0` `gen_c8_0_1` `gen_c8_0_2` `gen_c8_0_3` `gen_c8_0_4`

</details>

### decode-hint-nop (3)

By opcode: `0F18 /0` 3

<details><summary>tests</summary>

`gen_0f18_0_1` `gen_0f18_0_2` `gen_0f18_0_4`

</details>

### fprem-cc (2)

By opcode: `fprem` 1, `fprem1` 1

<details><summary>tests</summary>

`fprem` `fprem1`

</details>

### fsave-reserved (1)

By opcode: `fsave_frstor` 1

<details><summary>tests</summary>

`fsave_frstor`

</details>

### fyl2xp1-domain (1)

By opcode: `fyl2xp1` 1

<details><summary>tests</summary>

`fyl2xp1`

</details>

## Differences below v86_64's runner (raw bits only)

| What | Count | Real x86 | qemu 8.2.2 |
|---|---|---|---|
| MMX writes to x87 registers | 103,486 register values in 12,659 tests | Sets the exponent field (bits 64–79) to all ones. | Leaves it 0. Visible to code that reads st0–7 or `FSAVE`s after MMX without `EMMS`. |
| RF in the EFLAGS of a fault | 890 tests | Set in the saved EFLAGS. | Clear. |
| FPU status C1 ("rounded up") | 200 tests | Set by inexact results that rounded up. | Clear in all 200. |
| FPU status DE (denormal operand) | 43 tests | Set. | Clear. |
| x87 control word after `FLDCW` | 10 tests | Reserved bits normalised (e.g. `0x195b`). | Stored as written (e.g. `0x991b`). |
| `MXCSR.DE` | 7 tests (`CVTPS2PD`, `DPPS`, `ADDSUBPS`) | Set for denormal inputs. | Clear. |
| `fsin`/`fcos`/`fptan`/`fsincos` precision | `fptan`, `fsincos` | Full 64-bit-mantissa results; `fptan(π)` = `+5.4e-20`. | Computed in host `double` (`target/i386/tcg/fpu_helper.c`: `tan(floatx80_to_double(...))`); `fptan(π)` = `-1.22e-16`. Hidden by `run.js`'s absolute 1e-7 tolerance. PE is often missing too. |

## Not observable through qemu's gdb server

qemu 8.2.2's gdb server reports `ftag`, `fiseg`, `fioff`, `foseg`, `fooff` and `fop` as a constant 0 (`target/i386/gdbstub.c`), so these were not compared. One consequence: `gdb-extract-def` decides from `$ftag` whether st0–7 are empty (printed as `"invalid"`). Under qemu every slot looks valid, so **an emulated fixture records stale values where the real one says `invalid`**. Compared the way `run.js` does (expected = real), this is harmless; but emulated fixtures used *as* expected values would assert on empty registers.

## gdb under emulation

- **gdb cannot trace a program inside a `linux/amd64` / `linux/386` container**: `ptrace: Function not implemented` (qemu-user has no ptrace).
- **Through qemu's gdb server it is reliable.** On the 7 traced tests (`f2xm1`, `fprem`, `fptan`, `fscale`, `fsincos`, `fsqrt`, `fyl2x`), `stepi` visited the same instructions with the same `eip` at every step as on real hardware. Differences in the traces are the CPU results listed above (PE, C1, `fptan`/`fsincos` values), never the stepping itself. Native gdb shows TF in EFLAGS while stepping and qemu does not; the comparison ignores it.
- **aarch64 gdb cannot print every x87 value**: it converts through a double and refuses MMX-left pseudo-NaNs/unnormals. `x87print.py` prints from raw bits with glibc's rules instead.

## What this means

- **Usable as is:** building and running x86/i386 test programs, integer and SSE behaviour, ordinary x87 arithmetic, `gdb` stepping via qemu's gdb server.
- **Not usable as hardware truth:** fixtures involving x87 stack overflow/underflow, `FCOMI`-family flags, `fsin`/`fcos`/`fptan`/`fsincos` beyond ~16 significant digits, the instruction encodings above, `FSAVE` images, `MXCSR`/x87 exception flags, or RF.
- **For v86_64:** emulated fixtures fail 1,038 of 16,529 tests under its own runner. They must not replace real-x86 fixtures. Generate fixtures on real x86 (its CI on GitHub's x86 runners, or `release/emulation-equivalence.sh gen ref` on any x86 machine), and use the VM to build and run.
