---
name: debugging
description: How to find the actual cause of a bug instead of changing things until the symptom disappears
triggers: [bug, debug, broken, failing, crash, error, not working, regression, flaky]
---

The goal is to explain the failure, not to make it stop. Those are different, and only one of them stays fixed.

## Reproduce it first

Find the smallest input or sequence that triggers it, reliably. If you cannot reproduce it, you cannot know whether you fixed it — and every subsequent step is guessing.

If it is intermittent, that is information: intermittent means timing, ordering, uninitialized state, or a shared resource. Run it in a loop and see how often.

## Read the actual error

The stack trace names a file and a line. Go there and read the surrounding code before forming a theory. Most of the time the answer is on screen and the temptation is to skip past it.

Read the *first* error, not the last. Later errors are usually consequences.

## Form one hypothesis at a time

State what you think is happening and what you would expect to observe if you were right. Then check that specific thing — with a log line, a debugger, or a targeted test.

Changing several things at once and finding the symptom gone teaches you nothing, and you will not know which change to keep.

## Bisect when you are lost

If it worked before and does not now, find the commit. `git bisect` answers in log(n) steps what reading code answers in hours.

If there is no known-good version, bisect the input or the code path instead: remove half, see if it still fails.

## Before saying it is fixed

- Confirm the reproduction no longer reproduces.
- Explain *why* the change fixes it. "It works now" without a mechanism usually means the bug moved.
- Check whether the same mistake exists elsewhere in the codebase.
- Consider whether a test would have caught it, and add that test.

Report what you found, what you changed, and what you ran. If you fixed the symptom without understanding the cause, say so plainly — that is important information for whoever reads the change.
