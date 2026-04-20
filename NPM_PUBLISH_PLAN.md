# Publish `fpdf` as an npm package (`@the-hcma/fpdf`)

## Goal

Publish `fpdf` to npm as a scoped package (`@the-hcma/fpdf`) so users can run it via `npx @the-hcma/fpdf`.

## Current State

- TypeScript CLI, builds to `dist/cli.js`
- `package.json` has `"bin": { "fpdf": "dist/cli.js" }` and `"version": "0.1.0"`
- `fpdf` is **not available** as an unscoped npm name → use `@the-hcma/fpdf`
- License: **PolyForm Noncommercial 1.0.0** (SPDX: `PolyForm-Noncommercial-1.0.0`)

---

## Plan

### Phase 1: Package readiness

- [ ] **Rename package** in `package.json` to `@the-hcma/fpdf`
- [ ] **Set `license`** to `PolyForm-Noncommercial-1.0.0` in `package.json`
- [ ] **Add `files` field** to `package.json`: `["dist", "README.md", "LICENSE"]`
- [ ] **Add metadata fields** to `package.json`:
  ```json
  "repository": {
    "type": "git",
    "url": "https://github.com/the-hcma/fpdf.git"
  },
  "homepage": "https://github.com/the-hcma/fpdf",
  "keywords": ["pdf", "cli", "form-fill", "pdf-forms"]
  ```
- [ ] **Add `publishConfig`** for public scoped access:
  ```json
  "publishConfig": { "access": "public" }
  ```
- [ ] **Add `prepublishOnly` script**: `"pnpm run check && pnpm run test && pnpm run build"`
- [ ] **Ensure `dist/cli.js` has a shebang** (`#!/usr/bin/env node`)

### Phase 2: CI — automated publish workflow

- [ ] **Create `.github/workflows/publish.yml`** triggered on GitHub Releases (or `v*` tag pushes):
  - checkout → setup Node 20 + pnpm → install → check → test → build → `npm publish --provenance`
- [ ] **Add `NPM_TOKEN`** as a repository secret
- [ ] **Enable npm provenance** (`--provenance`) for supply-chain transparency

### Phase 3: Versioning & release process

- [ ] **Document the release process** in `README.md` or `RELEASING.md`
- [ ] **Choose a versioning strategy** (manual bumps vs. `changesets` / `release-please`)
- [ ] **Tag first release** as `v0.1.0` and publish

### Phase 4: Post-publish verification

- [ ] `npx @the-hcma/fpdf` works correctly (primary install method)
- [ ] `npm install -g @the-hcma/fpdf` installs and the `fpdf` command is available
- [ ] Package page on [npmjs.com](https://www.npmjs.com/) shows correct README, license, and metadata
