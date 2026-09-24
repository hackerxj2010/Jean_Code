---
name: writing-tests
description: How to write tests that would actually catch a regression, rather than tests that restate the implementation
triggers: [test, tests, testing, spec, coverage, unit test, integration test]
---

Write the test you would want to have when this breaks at 3am.

## Before writing anything

Read the existing tests for the module you are touching. Match their structure, their naming, and their level of abstraction. A test suite with two different styles is worse than one with either style.

## What to test

Test behaviour at the boundary, not the implementation in the middle:

- The input that produces the wrong answer, not the input that produces the obvious answer.
- The empty case, the single-element case, and the case one past a limit.
- What happens when a dependency fails, not only when it succeeds.
- Concurrency, if two callers can reach the code at once.

If you cannot describe the bug a test would catch, the test is not worth writing. A test that passes whatever the implementation does is a liability: it will need updating every time the code changes and will never once fail for a real reason.

## Writing the assertion

Assert on the thing that matters. `expect(result.status).toBe(404)` says what went wrong; `expect(result).toMatchSnapshot()` says only that something changed.

When a test fails, its name and its assertion should be enough to know what broke. Add a comment for the *why* when the case is non-obvious — the reader six months from now does not know which bug this was written for.

## Fixtures

Give each test its own fixture directory or database. Test runners execute in parallel by default, and shared mutable state produces failures that only appear under load and never reproduce locally.

## Before you claim it works

Run the test. Then break the code it covers and run it again — a test that passes against broken code is not a test. Report the actual output, not what you expect the output to be.
