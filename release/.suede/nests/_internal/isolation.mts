// The isolation contract, proved in the library's own DSL.
//
// Every test runs against its own copy of the module under test *and* of that
// module's first-party imports. These tests only pass while that holds: each
// one counts exactly once and expects to see exactly one, so any sharing
// between them turns the second of each pair into a 2.
import type { Expect, Given, Invoke } from "../dsl.import.meta.vitest.ts";
import { bump, tally } from "./fixtures/tally.ts";

/** State in the module under test itself. */
let local = 0;

const bumpLocal = (): number => ++local;

const localTally = (): number => local;

declare namespace Isolation {
  /** a dependency's state is the test's own … */
  export type DependencyFirst = Given<
    Invoke<typeof bump>,
    Expect<Invoke<typeof tally>, "=", 1>
  >;

  export type DependencySecond = Given<
    Invoke<typeof bump>,
    Expect<Invoke<typeof tally>, "=", 1>
  >;

  /** … and so is state in the module under test */
  export type ModuleFirst = Given<
    Invoke<typeof bumpLocal>,
    Expect<Invoke<typeof localTally>, "=", 1>
  >;

  export type ModuleSecond = Given<
    Invoke<typeof bumpLocal>,
    Expect<Invoke<typeof localTally>, "=", 1>
  >;
}
