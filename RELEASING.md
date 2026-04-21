# Releasing & Publishing

`fpdf` uses Google's [Release Please](https://github.com/google-github-actions/release-please-action) to automate versioning, changelog generation, and NPM publishing.

The release process relies entirely on **Conventional Commits** (`feat:`, `fix:`, `docs:`, etc.). 

## How to trigger a new release

1. **Develop and merge as usual**: Every time you merge PRs into `main` using Conventional Commits, the automated `release-please` GitHub action evaluates the commits since the last release.
2. **Review the Release PR**: `release-please` will automatically open (or update) a Pull Request titled `chore(main): release X.Y.Z`. This PR contains the version bumps in `package.json` and auto-generated updates to `CHANGELOG.md`.
3. **Merge the Release PR**: When you are ready to publish the new version, simply approve and **merge** the Release PR into `main`.

## What happens after merging?

Once the Release PR is merged:
1. `release-please` automatically generates a **GitHub Release** and tags the repository (e.g., `v0.2.0`).
2. The creation of this GitHub Release triggers the **NPM Publish** GitHub Action (`.github/workflows/npm-publish.yml`).
3. The NPM Publish action builds the project, tests it, and publishes it securely to the `npmjs.com` registry using `--provenance`.

## Manual Fallback

If for any reason the automated workflows fail, you can publish manually:
1. Ensure your local `main` branch is up to date.
2. Run `pnpm install` and verify the build passes via `pnpm run check && pnpm test`.
3. Manually update the version in `package.json` and generate the CHANGELOG.
4. Run `npm publish --access public` (Requires you to be logged into npm CLI via `npm login` and be part of `@the-hcma` organization).
