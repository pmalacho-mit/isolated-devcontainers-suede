// State that lives in a *dependency* of a module under test. Each test should
// get its own copy of this module, so one test's counting cannot be seen by the
// next one.

let count = 0;

export const bump = (): number => ++count;

export const tally = (): number => count;
