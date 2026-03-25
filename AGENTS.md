# AGENTS.md — Ground Rules for fpdf

This file defines the non-negotiable standards for all contributors (human or AI) working on this codebase. Every change must comply with these rules before it is considered complete.

---

## Language & Runtime

- TypeScript **strict mode** is always on — `"strict": true` in `tsconfig.json`, no exceptions.
- Target Node.js LTS (≥ 20). No deprecated APIs.
- Separate `tsconfig.web.json` for browser-targeted code. Never mix Node and browser globals in the same compilation unit.
- All source files use `.ts` extension. No `.js` files in `src/`.

---

## Formatting

- **Prettier** is the single source of truth for formatting. No manual style debates.
- Configuration is in `.prettierrc` at the repo root. Do not override it inline.
- Required settings:
  ```json
  {
    "semi": true,
    "singleQuote": true,
    "trailingComma": "all",
    "printWidth": 100,
    "tabWidth": 2,
    "arrowParens": "always"
  }
  ```
- Run `npm run format` before committing. A CI check will fail on unformatted files.
- Do not suppress Prettier with `// prettier-ignore` unless the block is machine-generated (e.g. an embedded binary blob).

---

## Linting

- **ESLint** with the TypeScript plugin is mandatory. Config lives in `eslint.config.ts` (flat config).
- Required rule sets:
  - `eslint:recommended`
  - `plugin:@typescript-eslint/strict-type-checked`
  - `plugin:@typescript-eslint/stylistic-type-checked`
- Rules that are **errors** (never warnings):
  - `@typescript-eslint/no-explicit-any`
  - `@typescript-eslint/no-unsafe-assignment`
  - `@typescript-eslint/no-unsafe-call`
  - `@typescript-eslint/no-unsafe-member-access`
  - `@typescript-eslint/no-unsafe-return`
  - `@typescript-eslint/no-floating-promises`
  - `@typescript-eslint/await-thenable`
  - `@typescript-eslint/no-unused-vars`
  - `no-console` (use a structured logger instead; see `src/logger.ts`)
- Run `npm run lint` and resolve all errors before opening a PR. Do not use `eslint-disable` comments unless absolutely unavoidable, and every suppression must include a comment explaining why.

---

## Testing

- **Vitest** is the test framework. All tests live under `src/__tests__/` or co-located as `*.test.ts`.
- **Coverage threshold** (enforced in CI): lines ≥ 80%, branches ≥ 73%, functions ≥ 80%. The branch threshold is set to 73% (not 75%) because Node.js v8 coverage measures ~2% lower than Node 25 for the same code.
- Every public function in `src/` must have at least one unit test.
- Tests must be **deterministic**: no `Math.random()`, no un-mocked `Date.now()`, no real file I/O in unit tests (use `vi.mock` or in-memory fixtures).
- Use **real file fixtures** (stored in `src/__tests__/fixtures/`) only in integration tests, clearly marked with a `// integration` comment at the top of the file.
- Test file naming: `<module>.test.ts` mirrors the source file it covers.
- Each test must have a descriptive name that reads as a sentence: `it('returns an error when the PDF has no AcroForm', ...)`.
- Do not write tests that only assert that a mock was called — assert the observable output or side effect.

---

## Repository

- Remote: `https://github.com/the-hcma/fpdf` (private).
- Do not make the repository public without explicit approval.
- Never commit secrets, credentials, or API keys — use environment variables.

---

## Commits, Stacking & Pull Requests

- This project uses **Graphite** (`gt`) for branch stacking. All `gt` commands must be prefixed with `GRAPHITE_PROFILE=thehcma` (e.g. `GRAPHITE_PROFILE=thehcma gt submit`), or exported in the shell session before running any `gt` command.
- All work is done in stacked branches via `gt create`, `gt modify`, and `gt submit`.
- Never work directly on `main`. Always create a stack branch: `gt create -m "feat: description"`.
- Keep each branch in the stack focused on exactly one logical change. Stacks should map 1-to-1 with milestones or sub-tasks from [PLAN.md](./PLAN.md).
- Sync regularly: `gt sync` before starting new work; `gt restack` after upstream changes land.
- Submit stacks with `gt submit` — do not open PRs manually via the GitHub UI.
- Follow **Conventional Commits**: `feat:`, `fix:`, `chore:`, `docs:`, `test:`, `refactor:`.
- Each commit must pass `npm run check` (type-check + lint + format check) and `npm test`.
- Keep commits focused. One logical change per commit.
- PR descriptions must reference the relevant milestone from [PLAN.md](./PLAN.md).
- Before starting a new PR or branch, confirm the current PR is either merged or that all CI checks pass (lint, format, tests, coverage). Never start new work on a broken base.

---

## Security

- Never log, store, or transmit the raw contents of user PDF files beyond what is required to serve the local web UI.
- The Express server **must** bind to `127.0.0.1` only — never `0.0.0.0`.
- All file paths received from the CLI or the web UI must be validated and resolved with `path.resolve` before any file system operation. Reject paths that escape the working directory.
- No dynamic `eval`, `new Function`, or `child_process.exec` with user-controlled strings.
- Dependencies must be reviewed before adding. Run `npm audit` after every `npm install`.

---

## Dependencies

- Prefer well-maintained, typed packages. Avoid packages with no TypeScript types and no `@types/*` available.
- Do not add a dependency for something trivially implementable in ~10 lines of TypeScript.
- Separate `dependencies` (runtime) from `devDependencies` strictly.
- Lock file (`package-lock.json`) must always be committed.

---

## CI Checks (all must pass)

```
npm run typecheck    # tsc --noEmit
npm run lint         # eslint src/
npm run format:check # prettier --check src/
npm test             # vitest run --coverage
```

No PR may be merged with a failing CI check. No exceptions.
