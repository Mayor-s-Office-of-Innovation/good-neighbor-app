# Contributing

## Expectations for volunteer contributors

- Code reviews may be by volunteers, so temper your expectations on responsiveness
- Look for "good first issue" tags, if you're just getting started
- When you pick up a story, assign yourself.
- If you want to pair with a code owner or more experienced engineer, just ask
- This project moves fast: if you pick up a story, even as a volunteer, the expectation is that you're committing to execute on that story in a reasonable time frame: 24 hours for small stories, up to 3 days for more complex stories. If you can't meet that expectation, no problem, but unassign yourself and let City product owner know
- Once you're up and running, please let a code owner know if you have feedback on the process of getting set up, or how we can adjust docs, resources, etc., to make it easier to get started
- Any questions? Concerns? Ping the City product lead in Slack

## Development Workflow

1. Create a branch from `dev`.
2. Keep changes small and focused.
3. If working to a frontend spec, adhere to the spec (e.g., from Figma).
4. Run local checks **first** before opening a pull request.
5. Include tests or explain why tests are not applicable.
6. Fix CI/CD issues **before** requesting review.
7. If automated code review is running, respond to any issues identified.
8. Request review from a code owner.

## Required Local Checks

```bash
pre-commit install
npm install
npm run format:check
npm run lint
npm test
npm run build
```

## Using AI

You're welcome to use AI tools to help you contribute. But there are two important ground rules (these were copied from <a href="https://github.com/npmx-dev/npmx.dev?tab=contributing-ov-file#using-ai">npmx.dev's contributing docs</a>):

1. Never let an LLM speak for you
When you write a comment, issue, or PR description, use your own words. Grammar and spelling don't matter – real connection does. AI-generated summaries tend to be long-winded, dense, and often inaccurate. Simplicity is an art. The goal is not to sound impressive, but to communicate clearly.

2. Never let an LLM think for you
Feel free to use AI to write code, tests, or point you in the right direction. But always understand what it's written before contributing it. Take personal responsibility for your contributions. Don't say "ChatGPT says..." – tell us what you think.

For more context, see Using <a href="https://roe.dev/blog/using-ai-in-open-source">AI in open source</a>.

## Commit Signing

Contributors should sign commits with GPG or SSH signing keys. Signed commits provide the audit trail expected by the CCSF SDLC standard.

## Infrastructure Changes

Infrastructure changes must be made in Terraform under `infra/`. Do not create cloud resources manually. Pull requests must include the Terraform plan output from CI.
