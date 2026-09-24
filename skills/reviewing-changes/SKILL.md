---
name: reviewing-changes
description: How to review a diff for defects that matter, without padding the review with style opinions
triggers: [review, code review, pr, pull request, merge request, feedback on this change]
---

A review's value is the bugs it catches. Everything else is noise that trains the author to skim reviews.

## Read the change in context

Open the files, not just the diff. A change that looks correct in isolation can be wrong given what the surrounding code assumes — and the diff hides exactly that.

Work out what the change is *for* before judging how it does it.

## What to look for, roughly in order

1. **Correctness at the edges.** Empty input, a single element, off-by-one at a boundary, integer overflow, a value that can be null.
2. **Error paths.** Is a failure swallowed? Does a `catch` hide a bug it cannot handle? Does a partial failure leave inconsistent state?
3. **Resource handling.** Files, connections, and locks released on every path including the error path.
4. **Concurrency.** Two callers at once, a check-then-act on shared state, an `await` between reading and writing.
5. **Assumptions that do not hold.** A cast that could fail, a lookup that assumes a key exists, an invariant the caller is not required to maintain.
6. **Consistency with the codebase.** A second way to do something the project already does one way is a real cost, not a style preference.

## Writing a finding

For each one, give the file and line, what breaks, and the concrete input or state that triggers it. If you cannot name the trigger, you have a suspicion rather than a finding — say which.

Do not restate what the code does. The author knows; they wrote it.

## What not to say

Skip formatting a linter handles. Skip naming preferences that are not actively confusing. Skip suggesting a refactor that is out of scope for the change.

An empty review is a valid outcome. Padding a clean change with minor observations makes the next review's real findings harder to see.
