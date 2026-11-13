// A workspace VM's size: CPUs, memory and disk. Decided when the VM is made, from, in order:
// `desolate up --cpus/--memory/--disk`, then the domain's size (`desolate domain <d> size`),
// then the stack's defaults, which come from this Mac itself (its cores and memory: worked out
// each time, stored nowhere, so they never go stale), which DESOLATE_WORKSPACE_CPUS /
// _MEMORY_MIB / _DISK_GIB override.
//
// What each costs: a CPU is a share of the Mac's time (nothing is reserved; an idle VM costs
// almost nothing). Memory is a ceiling, not a reservation: macOS gives a VM pages as it
// touches them, and is slow to take them back, so a VM that once used 8 GiB tends to hold
// them until it stops. Disk grows as it is written, up to the size.
// In-source tests (suede.nests: `npm run test:nests`). Types only: erased when node runs this.
import type { Expect, Invoke, Table } from "../.suede/nests/dsl.import.meta.vitest.ts";

export type Size = { cpus: number; memoryMiB: number; diskGiB: number };
// (Disk from 30 GiB: every VM is cloned from a 30 GiB base, and a clone's disk can only grow.)
export const LIMITS = { cpus: [1, 64], memoryMiB: [1024, 262_144], diskGiB: [30, 2048] } as const;

/** "8g", "8gb", "8GiB", "512m", "8192" (MiB): memory in MiB, or null. */
export const parseMemory = (value: unknown): number | null => {
  const match = /^\s*(\d+(?:\.\d+)?)\s*(g|gb|gib|m|mb|mib)?\s*$/i.exec(String(value ?? ""));
  if (!match) return null;
  const amount = Number(match[1]);
  const mib = /^g/i.test(match[2] ?? "") ? amount * 1024 : amount;
  return Number.isFinite(mib) && Number.isInteger(Math.round(mib)) ? Math.round(mib) : null;
};

declare namespace parseMemory {
  export type Spellings = Table<typeof parseMemory, [
    [args: [value: "8g"], expected: 8192],
    [args: [value: "8GiB"], expected: 8192],
    [args: [value: "1.5g"], expected: 1536],
    [args: [value: "512m"], expected: 512],
    [args: [value: "4096"], expected: 4096],
    [args: [value: "lots"], expected: null],
    [args: [value: "-4g"], expected: null],
  ]>;
}

/** "60g", "60GiB", "60": disk in GiB, or null. */
export const parseDisk = (value: unknown): number | null => {
  const match = /^\s*(\d+)\s*(g|gb|gib)?\s*$/i.exec(String(value ?? ""));
  return match ? Number(match[1]) : null;
};

/** A size, checked: each part within its limits, whole numbers. The reason when it is not. */
export const checkSize = (size: Partial<Size>): string | null => {
  for (const key of ["cpus", "memoryMiB", "diskGiB"] as const) {
    const value = size[key];
    if (value === undefined) continue;
    const [min, max] = LIMITS[key];
    if (!Number.isInteger(value) || value < min || value > max) return `${key === "cpus" ? "CPUs" : key === "memoryMiB" ? "memory" : "disk"} must be from ${key === "memoryMiB" ? `${min / 1024} GiB to ${max / 1024} GiB` : key === "diskGiB" ? `${min} GiB to ${max} GiB` : `${min} to ${max}`}`;
  }
  return null;
};

declare namespace checkSize {
  export type Cases = Table<typeof checkSize, [
    [args: [size: { cpus: 4; memoryMiB: 8192; diskGiB: 60 }], expected: null],
    [args: [size: { cpus: 0 }], expected: "CPUs must be from 1 to 64"],
    [args: [size: { memoryMiB: 512 }], expected: "memory must be from 1 GiB to 256 GiB"],
    [args: [size: { diskGiB: 20 }], expected: "disk must be from 30 GiB to 2048 GiB"],
  ]>;
}

/** What a workspace gets by default on a Mac with these cores and this much memory: half the
 *  cores (2 to 4: an agent and a build, without crowding the Mac), a quarter of the memory
 *  (3 to 8 GiB: a devcontainer, a language server, a test run), and 30 GiB of disk. */
export const defaultsFor = (cores: number, memoryMiB: number): Size => ({
  cpus: Math.min(4, Math.max(2, Math.floor(cores / 2))),
  memoryMiB: Math.min(8192, Math.max(3072, Math.floor(memoryMiB / 4 / 1024) * 1024)),
  diskGiB: 30,
});

declare namespace defaultsFor {
  /** an 8 GB M1, a 16 GB M2, a 32 GB M3 Pro, a 64 GB M2 Max */
  export type Macs = Table<typeof defaultsFor, [
    [args: [cores: 8, memoryMiB: 8192], expected: { cpus: 4; memoryMiB: 3072; diskGiB: 30 }],
    [args: [cores: 8, memoryMiB: 16384], expected: { cpus: 4; memoryMiB: 4096; diskGiB: 30 }],
    [args: [cores: 4, memoryMiB: 16384], expected: { cpus: 2; memoryMiB: 4096; diskGiB: 30 }],
    [args: [cores: 12, memoryMiB: 32768], expected: { cpus: 4; memoryMiB: 8192; diskGiB: 30 }],
    [args: [cores: 12, memoryMiB: 65536], expected: { cpus: 4; memoryMiB: 8192; diskGiB: 30 }],
  ]>;
}

/** The size, for a person: "4 CPUs, 8 GiB memory, 30 GiB disk". */
export const describe = (size: Size): string =>
  `${size.cpus} CPU${size.cpus === 1 ? "" : "s"}, ${size.memoryMiB % 1024 === 0 ? `${size.memoryMiB / 1024} GiB` : `${size.memoryMiB} MiB`} memory, ${size.diskGiB} GiB disk`;

declare namespace describe {
  export type Said = Expect<Invoke<typeof describe, [size: { cpus: 4; memoryMiB: 8192; diskGiB: 30 }]>, "=", "4 CPUs, 8 GiB memory, 30 GiB disk">;
}

/** Each part, the first that is set: the given ones, then the next. */
export const merge = (...sizes: (Partial<Size> | null | undefined)[]): Size => {
  const out: Partial<Size> = {};
  for (const size of sizes) for (const key of ["cpus", "memoryMiB", "diskGiB"] as const) if (out[key] === undefined && size?.[key] !== undefined) out[key] = size[key];
  return out as Size;
};

declare namespace merge {
  export type Order = Expect<Invoke<typeof merge, [a: { cpus: 8 }, b: { cpus: 2; memoryMiB: 4096 }, c: { cpus: 1; memoryMiB: 1024; diskGiB: 30 }]>, "=", { cpus: 8; memoryMiB: 4096; diskGiB: 30 }>;
}
