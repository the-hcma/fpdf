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
- Run `pnpm run format` before committing. A CI check will fail on unformatted files.
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
- Run `pnpm run lint` and resolve all errors before opening a PR. Do not use `eslint-disable` comments unless absolutely unavoidable, and every suppression must include a comment explaining why.

---

## Testing

- **Vitest** is the test framework. All tests live under `src/__tests__/` or co-located as `*.test.ts`.
- **Coverage threshold** (enforced in CI): lines ≥ 80%, branches ≥ 73%, functions ≥ 80%. The branch threshold is set to 73% (not 75%) because Node.js v8 coverage measures ~2% lower than Node 25 for the same code.
- Every public function in `src/` must have at least one unit test.
- Tests must be **deterministic**: no `Math.random()`, no un-mocked `Date.now()`, no real file I/O in unit tests (use `vi.mock` or in-memory fixtures).
- Fixed-delay sleeps in tests are prohibited (e.g. `setTimeout(50)`, `await new Promise((r) => setTimeout(r, n))`) because they are a flake smell. Use condition-based synchronization (`vi.waitFor`, explicit events, observable state transitions) instead.
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

> See [GRAPHITE.md](./GRAPHITE.md) for the full Graphite workflow reference (branch naming, stack creation, navigation, submission, troubleshooting, and advanced rebasing).

- This project uses **Graphite** (`gt`) for branch stacking.
- All work is done in stacked branches via `gt create`, `gt modify`, and `gt submit`.
- Never work directly on `main`. Always create a stack branch: `gt create -m "feat: description"`.
- Keep each branch in the stack focused on exactly one logical change. Stacks should map 1-to-1 with milestones or sub-tasks from [PLAN.md](./PLAN.md).
- Sync regularly: `gt sync` before starting new work; `gt restack` after upstream changes land.
- Submit stacks with `gt submit --no-interactive` — do not open PRs manually via the GitHub UI.
- After submitting, always mark PRs as ready for review: `gh pr ready <number>`. `gt submit --no-interactive` creates drafts by default.
- To merge a PR, add the `merge-it` label: `gh pr edit <number> --add-label merge-it`. Never use `gh pr merge` directly.
- Follow **Conventional Commits**: `feat:`, `fix:`, `chore:`, `docs:`, `test:`, `refactor:`.
- **All commits must be GPG-signed.** Ensure `commit.gpgsign = true` is set in git config and the signing key is uploaded to GitHub (Settings → SSH and GPG keys) so commits show as "Verified".
- Each commit must pass `pnpm run check` (type-check + lint + format check) and `pnpm test`.
- Keep commits focused. One logical change per commit.
- PR descriptions must reference the relevant milestone from [PLAN.md](./PLAN.md).
- Before starting a new PR or branch, confirm the current PR is either merged or that all CI checks pass (lint, format, tests, coverage). Never start new work on a broken base.

---

## Shell Scripts

- **No `.sh` extension.** Shell scripts in `scripts/` have no file extension (e.g. `scripts/fpdf`, not `scripts/fpdf.sh`). The shebang line declares the interpreter.
- **`shellcheck`** is mandatory for all shell scripts. CI runs `shellcheck` against all extension-less files in `scripts/` on every push (relying on the no-extension convention to identify shell scripts).
- **`readonly`** must be used for every script-level variable that is assigned once and never modified. Declare and assign separately to avoid masking exit codes (SC2155):
  ```bash
  var="$(some_command)"
  readonly var
  ```
- **Non-exported variables must be lowercase.** Uppercase is reserved for exported environment variables (`export FOO=bar`). Script-level constants, loop variables, and function locals all use `snake_case`.
- **Use `local` for all function-scoped variables.** For parameters or literal assignments that won't change, prefer `local -r`:
  ```bash
  my_func() {
    local -r mode="${1:-default}"   # parameter — safe to combine
    local result                    # command substitution — declare separately
    result=$(some_command)          # assign after to preserve exit code
  }
  ```
- Do not use `local -r var=$(cmd)` — shellcheck SC2155 flags it because `local` masks the command's exit code.

---

## Security

- Never log, store, or transmit the raw contents of user PDF files beyond what is required to serve the local web UI.
- The Express server **must** bind to `127.0.0.1` only — never `0.0.0.0`.
- All file paths received from the CLI or the web UI must be validated and resolved with `path.resolve` before any file system operation. Reject paths that escape the working directory.
- No dynamic `eval`, `new Function`, or `child_process.exec` with user-controlled strings.
- Dependencies must be reviewed before adding. Run `pnpm audit` after every `pnpm install`.

---

## Dependencies

- Prefer well-maintained, typed packages. Avoid packages with no TypeScript types and no `@types/*` available.
- Do not add a dependency for something trivially implementable in ~10 lines of TypeScript.
- Separate `dependencies` (runtime) from `devDependencies` strictly.
- Lock file (`pnpm-lock.yaml`) must always be committed.

---

## CI Checks (all must pass)

```
pnpm run typecheck    # tsc --noEmit
pnpm run lint         # eslint src/
pnpm run format:check # prettier --check src/
pnpm test             # vitest run --coverage
```

No PR may be merged with a failing CI check. No exceptions.
