# Contributing

## Development Workflow

1. Create a branch from `main`.
2. Keep changes small and focused.
3. Run local checks before opening a pull request.
4. Include tests or explain why tests are not applicable.
5. Request review from a code owner.

## Required Local Checks

```bash
pre-commit install
npm install
npm run format:check
npm run lint
npm test
npm run build
```

## Commit Signing

Contributors should sign commits with GPG or SSH signing keys. Signed commits provide the audit trail expected by the CCSF SDLC standard.

## Infrastructure Changes

Infrastructure changes must be made in Terraform under `infra/`. Do not create cloud resources manually. Pull requests must include the Terraform plan output from CI.
