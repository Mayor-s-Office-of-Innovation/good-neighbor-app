# Review Checklist

## TODO: Add Other Review Requirements

Claude uses this file when you trigger the [code review skill](https://code.claude.com/docs/en/code-review).  

Claude's default code review skill (ask your Claude to check in its latest [system prompt](https://github.com/Piebald-AI/claude-code-system-prompts)) is pretty limited.  So for anything you think is important to review for, this is one way to try to make sure it happens before code gets to PR.

## Testing

- [ ] **Unit coverage:** aim for 80% of changed lines and branches.
- [ ] **E2E coverage:** each new workflow has a Playwright test. List the flows covered.
- [ ] **Test quality**
  - **Tests user behaviour**: Checks what a user or caller sees: a text, value, request body or URL. No test depends on behaviour in the source code that the user doesn't see.
  - **Element selection**: Finds elements by role, id or data attribute, and reads copy through `t()`. No CSS-class selectors or hard-coded copy.
  - **Can fail:** Fails when the code it covers breaks.
  - **Is deterministic**: waits on conditions, not sleeps; uses a fake clock; passes alone and in any order.
- [ ] **Test location**
  - **Unit tests** cover logic, edge cases and error branches. Most tests are unit tests.
  - **Component tests** call templates and handlers directly, with browser globals stubbed.
  - **E2E tests** cover key user journeys across components, plus their key error and edge states. They don't aim for full coverage.
  - When an E2E test finds a bug, first add the lowest-level test that catches it.

### Not a Target Yet

We haven't optimized test suite run time yet, so report on this target but we don't need to meet this target for review

- [ ] **Speed:** each unit suite (`admin-frontend`, `frontend`, `backend`) runs in 5 s or less, and CI in 5 minutes or less. Give the time of each suite the PR touches. One over target, or more than 10% slower, needs a reason.

### Proof in the PR

If you're helping draft content for the PR

- [ ] Give before/after coverage for each changed module
- [ ] Give before/after E2E coverage for each changed or new workflow
