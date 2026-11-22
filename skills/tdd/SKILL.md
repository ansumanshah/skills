---
name: tdd
description: Build features and fix bugs through test-driven development. Use for test-first implementation, "red green", "TDD", a bug fix needing a regression test, or integration tests at a module boundary.
---

# TDD

## Agree on public boundaries

Read the project's runner and commands in `package.json`, Makefile, or justfile.
List each proposed public interface with one line on what tests there catch and miss.
Agree on these boundaries and their caller-visible behaviors with the user before testing.
Skip this agreement only for a single bug fix; test the boundary where the bug appears.
Finish when the boundaries, behaviors, and test commands are settled.

## Run one vertical slice

1. Pick one agreed behavior at a public boundary.
   Write one test for the result a caller needs.
   Take its expected value from a known literal, a worked example, or the spec.
   Keep the expectation independent of the implementation's calculation.
   Finish when this test expresses one observable behavior and an independent expectation.
2. Run the narrowest test. Watch it fail for the intended missing behavior: red.
   Repair setup, syntax, or fixture failures until the behavior itself causes the failure.
   Finish when you have observed and recorded that red result.
3. Write the least implementation needed for this behavior. Run the narrow test again.
   Finish when this test passes: green.
4. Run the existing suite with the project's runner.
   On a shared machine, wrap suites in `build-queue` when it is installed.
   Finish when the suite is green, then choose the next behavior and repeat from step 1.

Complete each red-to-green slice before starting another behavior's test.
Keep tests tied to public outcomes so they survive changes to internal structure.

## Choose collaborators

Use real collaborators and in-memory fakes where practical.
Mock only process boundaries or slow or nondeterministic inputs, such as network,
clock, randomness, or paid APIs.
When choosing a mock or fake, read [mocking examples](mocking.md).
Finish when each substitute has a boundary or nondeterminism reason and expectations stay independent.

## Refactor on green

Refactor as its own step after tests pass. Keep behavior fixed and rerun affected tests.
Finish that step when the suite remains green before beginning another behavior.

## Report the evidence

Finish when every agreed behavior has a test observed red before its implementation or fix,
and the full suite is green.
Report which tests were added, what each guards, the observed red reasons, and suite results.
