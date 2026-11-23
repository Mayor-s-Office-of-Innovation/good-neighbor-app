# ADR 0022: Testing guidelines

## Status

Proposed (2026-11-02). Starts with #722, which adds unit tests to the admin dashboard before its `main.js` is split.

## Context

Having enough tests helps catch bugs before review and is important to help AI tools change code quickly and safely (especially for higher risk, bigger changes like refactors).

At the same time, we want to avoid having useless, fragile, or long running tests that slow down development without adding enough value.

We added this ADR as part of #722 to split up `admin-frontend/src/main.js`, and we wanted enough test coverage to safely do the refactor (previously had no test coverage). Adding tests also uncovered 8 bugs during this work.

## Decision

- **Encourage increasing coverage on code that changes, but no hard gates** Coverage is a blunt instrument that's not a great proxy for test quality, but still, having some coverage target gives AI agents a goal to go after. 
  - Aim for 80% unit test coverage on all changed lines and branches in every PR
  - Every new workflow should be covered by a Playwright E2E test
  - There are no hard gates based on these targets.  Humans decide if each PR is good enough or not.
- **Tests SHOULD run fast enough to keep development quick**
  - Unit test suites for `admin-frontend`, `frontend`, and `backend` should always run in 5s or less (in local and CI)
  - CI should run in 5 minutes or less
  - CI deploying should also ideally take less than 5 minutes
- **Tests SHOULD follow good habits for high quality tests (and avoid bad habits)**
  - Tests SHOULD check specific outcome a user or caller sees, not text in source code
  - Tests SHOULD break when the code it covers has a bug
  - Tests SHOULD find elements by role, id or data attribute and read copy through `t()` 
  - Tests SHOULD NOT look for elements by text that may be localized
  - Tests SHOULD be deterministic. Waits on conditions, uses a fake clock, uses deterministic synthetic data.
- **Tests SHOULD test behavior at the lowest layer that can catch the bug**
  - Unit tests SHOULD cover logic and more completely cover edge cases and errors
  - Component tests SHOULD call a component's templates and handlers directly, with browser globals stubbed. Browser rendering and events go in E2E tests.
  - E2E tests SHOULD cover each key user journey in a real browser
    - Usually these integrate multiple components
    - And we want to test a few key error and edge states

## Consequences

- Add a `REVIEW.md` file and other docs that encode the decisions above
  - Will do this first with `main.js` before refactoring that file for #722
- Add an automated tool during CI that shares visible coverage information every time the CI runs (i.e. each time PR code changes, there should be a brief report for humans to see)
- We don't meet the timing targets yet, and don't need to immediately. But when we're over target (whatever the team think is too slow), we should do some work to optimize
