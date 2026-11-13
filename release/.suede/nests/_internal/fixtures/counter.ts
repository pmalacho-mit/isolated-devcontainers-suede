// A subject for the library's own tests, kept inside `release/` so that nothing
// internal reaches for a file that only exists in this repository.
//
// Its tests are written under `Spec`, not `Tests`: they are here to be *printed*
// by the harness, never collected and run. Using a different root also keeps
// discovery from ever picking this file up.
import type {
  Expect,
  Construct,
  Call,
  Given,
} from "../../dsl.import.meta.vitest.ts";

export class Counter {
  #count: number;
  readonly step: number;
  readonly history: number[] = [];

  constructor(initial = 0, step = 1) {
    this.#count = initial;
    this.step = step;
  }

  get count(): number {
    return this.#count;
  }

  increment(times = 1): this {
    for (let i = 0; i < times; i++) {
      this.#count += this.step;
      this.history.push(this.#count);
    }
    return this;
  }

  reset(): void {
    this.#count = 0;
    this.history.length = 0;
  }
}

declare namespace Counter {
  type Counter = Construct<typeof Counter, [10, 2]>;

  /** reset() empties history, and does so on the same array object. */
  export type Reset = Given<
    [Call<Counter, "increment", [2]>, Call<Counter, "reset">],
    [
      Expect<Counter["count"], "=", 0>,
      Expect<Counter["history"], "isEmpty">,
      Expect<Counter["history"], "excludes", 12>,
    ]
  >;
}
