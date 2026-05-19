# Releasing & Publishing

`fpdf` uses Google's [Release Please](https://github.com/googleapis/release-please-action) to automate versioning, changelog generation, and NPM publishing.

The release process relies entirely on **Conventional Commits** (`feat:`, `fix:`, `docs:`, etc.).

## Merge strategy (avoid duplicate changelog lines)

Release Please walks **every** commit on `main` since the last tag. If a PR is merged with **Create a merge commit**, GitHub records both the branch commit (e.g. `fix(scope): …`) and a merge commit whose body repeats that same line. Release Please treats them as two separate changes, so the release PR lists the same fix twice in **`CHANGELOG.md` and the PR description** ([upstream discussion](https://github.com/googleapis/release-please/issues/2476)).

This repository allows **squash merge only** (merge commits and rebase merges are disabled in GitHub settings). Squash uses the PR title as the commit subject and an empty squash body (`squash_merge_commit_message: BLANK`), which matches the assert step in `.github/workflows/release-please.yml`.

That policy prevents duplicate changelog entries such as those in [PR #378](https://github.com/the-hcma/fpdf/pull/378) after [PR #377](https://github.com/the-hcma/fpdf/pull/377) was merge-committed before squash-only was enforced.

## How to trigger a new release

1. **Develop and merge as usual**: Every time you merge PRs into `main` using Conventional Commits, the automated `release-please` GitHub action evaluates the commits since the last release.
2. **Review the Release PR**: `release-please` will automatically open (or update) a Pull Request titled `chore(main): release X.Y.Z`. This PR contains the version bumps in `package.json` and auto-generated updates to `CHANGELOG.md`.
   - After each bot update, **Release & Publish** runs a `ci` check on the release PR head commit (required for merge). If that check is missing, close and reopen the release PR, or re-run the failed workflow from the Actions tab.
   - **Optional (recommended):** add a `RELEASE_PLEASE_TOKEN` repository secret (fine-grained PAT with `contents` + `pull_requests` write on this repo) and pass it to `googleapis/release-please-action` so release PR updates also trigger the normal **CI** workflow via `pull_request` events. See [release-please-action](https://github.com/googleapis/release-please-action#other-actions-on-release-please-prs).
3. **Merge the Release PR**: When you are ready to publish the new version, simply approve and **merge** the Release PR into `main`.

## What happens after merging?

Once the Release PR is merged:
1. `release-please` automatically generates a **GitHub Release** and tags the repository (e.g., `v0.2.0`).
2. The **Release & Publish** workflow (`.github/workflows/release-please.yml`) runs `publish-npm` on `main`.
3. npm publish uses **trusted publishing** (OIDC) from the `npm-production` GitHub Environment — no long-lived `NPM_TOKEN` required.

If publish fails with OIDC / 404 errors, confirm on [npm package settings](https://www.npmjs.com/package/@the-hcma/fpdf) that the trusted publisher matches:
- Repository: `the-hcma/fpdf`
- Workflow file: `release-please.yml`
- Environment (if set): `npm-production`

Do not remove `environment: npm-production` from the workflow unless you also remove or update the environment on npm.

## Manual Fallback

If for any reason the automated workflows fail, you can publish manually:
1. Ensure your local `main` branch is up to date.
2. Run `pnpm install` and verify the build passes via `pnpm run check && pnpm test`.
3. Manually update the version in `package.json` and generate the CHANGELOG.
4. Run `npm publish --access public` (Requires you to be logged into npm CLI via `npm login` and be part of `@the-hcma` organization).
