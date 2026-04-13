# `dep-update` Script — Implementation Plan

## Goal

A single, portable Bash script (`scripts/dep-update`) that:

1. **Discovers** outdated dependencies for npm/pnpm and/or Python projects
2. **Reports** them in dry-run mode (no side effects)
3. **Creates** a stacked Graphite PR stack — one PR per outdated dependency — inside a dedicated git worktree
4. **Cleans up** the worktree after the full stack is merged

**Tooling:** The script is implemented using **bash + git + gt + gh + jq** — plus the ecosystem tools it invokes (`pnpm`, `pip`, `uv`, `poetry`) as external commands. No Node.js helpers, no Python scripting.

---

## CLI Interface

```
scripts/dep-update [OPTIONS]
scripts/dep-update --cleanup [--dir <path>]

Modes:
  (no flags)          Update: create worktree, stack PRs, wait for merge, cleanup
  --dry-run           List outdated deps only; zero side effects
  --cleanup           Read saved state and clean up after stack is merged

Options:
  --dir <path>        Project root (default: current working directory)
  --ecosystem <eco>   Force: npm | python | auto  (default: auto)
  --semver-only       npm only: update within existing semver range
  --no-wait-ci        Skip per-PR CI polling; create full stack immediately
  --no-wait-merge     Exit after submitting stack; print --cleanup command
  -h, --help          Print usage and exit
```

---

## Tooling — JSON Parsing with `jq`

All CLI tools are invoked with **JSON output** where available, parsed with `jq`:

| Ecosystem | Command | jq filter |
|---|---|---|
| npm/pnpm | `pnpm outdated --json` | `to_entries[] \| "\(.key) \(.value.current) \(.value.latest)"` |
| Python/pip | `pip list --outdated --format=json` | `.[] \| "\(.name) \(.version) \(.latest_version)"` |
| Python/uv | `uv pip list --outdated --format=json` | same as pip |
| Python/pipenv | `pipenv run pip list --outdated --format=json` | same as pip |
| Python/poetry | `poetry show --outdated` | no stable JSON; parsed with `awk` |

> **Note:** `pnpm outdated` exits with code 1 when outdated packages are found. The script
> handles this with `set +e` / `set -e` around the call rather than triggering `set -euo pipefail`.

---

## Ecosystem Detection

Checked in `--dir` order of priority. Multiple ecosystems are both processed (npm first, then Python):

| File present | Ecosystem | Tool |
|---|---|---|
| `package.json` | npm | `pnpm` |
| `uv.lock` | Python | `uv` |
| `poetry.lock` | Python | `poetry` |
| `Pipfile.lock` | Python | `pipenv` |
| `requirements.txt` \| `pyproject.toml` | Python | `pip` |

---

## Prerequisite Checks

Prerequisite validation is split into two phases, both before any git or file-system changes:

### Phase 1 — Core tools (always required)

Checked immediately after `parse_args`, before ecosystem detection:

| Tool | Check | Error message |
|---|---|---|
| `git` | `command -v git` | `'git' is required but not found in PATH.` |
| `gt` | `command -v gt` | `'gt' (Graphite) is required. Install: https://graphite.dev/docs/install` |
| `gh` | `command -v gh` | `'gh' (GitHub CLI) is required. Install: https://cli.github.com` |
| `gh` auth | `gh auth status` | `'gh' is not authenticated. Run: gh auth login` |
| `gt` auth | `gt auth` exit code | `'gt' is not authenticated. Run: gt auth` |

In `--dry-run` mode, `gt` and `gh` auth checks are **skipped** (not needed for read-only operation).

### Phase 2 — Ecosystem tools (checked after detection)

Checked immediately after `detect_ecosystem`, before collecting outdated packages:

| Detected ecosystem | Tool checked | Error message |
|---|---|---|
| npm | `pnpm` | `'pnpm' is required for npm projects. Install: npm install -g pnpm` |
| Python/uv | `uv` | `'uv' is required for uv projects. Install: https://docs.astral.sh/uv/` |
| Python/poetry | `poetry` | `'poetry' is required for poetry projects. Install: https://python-poetry.org/docs/` |
| Python/pipenv | `pipenv` | `'pipenv' is required for Pipfile projects. Install: pip install pipenv` |
| Python/pip | `pip` or `pip3` | `'pip' is required for Python projects.` |

### Implementation sketch

```bash
check_core_prereqs() {
  local missing=0

  for tool in git gt gh; do
    if ! command -v "$tool" &>/dev/null; then
      log "ERROR: '${tool}' is required but not found in PATH."
      missing=$(( missing + 1 ))
    fi
  done

  (( missing > 0 )) && die "Install the missing tools above and retry."
}

check_auth_prereqs() {
  if ! gh auth status &>/dev/null; then
    die "'gh' is not authenticated. Run: gh auth login"
  fi
  if ! gt auth &>/dev/null; then
    die "'gt' is not authenticated. Run: gt auth"
  fi
}

check_ecosystem_prereqs() {
  local -r has_npm="$1"   # 1 | 0
  local -r py_tool="$2"   # uv | poetry | pipenv | pip | ""
  local missing=0

  if [[ "$has_npm" == '1' ]] && ! command -v pnpm &>/dev/null; then
    log "ERROR: 'pnpm' is required for npm projects. Install: npm install -g pnpm"
    missing=$(( missing + 1 ))
  fi

  if [[ -n "$py_tool" ]] && ! command -v "$py_tool" &>/dev/null; then
    if [[ "$py_tool" == 'pip' ]] && command -v pip3 &>/dev/null; then
      : # pip3 is acceptable
    else
      log "ERROR: '${py_tool}' is required. See plan for install instructions."
      missing=$(( missing + 1 ))
    fi
  fi

  (( missing > 0 )) && die "Install the missing tools above and retry."
}
```

> All missing tools are **collected and reported together** before exiting — the user sees the
> full list in one shot, not one error per run.

---

## Worktree Lifecycle

### Creation

```bash
# Adjacent sibling — avoids build-tool interference (node_modules, dist, etc.)
# e.g. /home/user/project/../project-dep-update-20260413T141800
worktree_name="${repo_name}-dep-update-$(date --utc +%Y%m%dT%H%M%S)"
worktree_path="$(dirname "$project_root")/${worktree_name}"
git -C "$project_root" worktree add "$worktree_path" main
```

All subsequent `git`, `gt`, `pnpm`, `pip`/`uv`/`poetry` commands run **within `$worktree_path`**.

### State File

Written to the original project root after worktree creation. Used by `--cleanup`.

**Path:** `<project_root>/.dep-update-state`

**Format** (plain key=value — no JSON, no jq):
```
worktree=/abs/path/to/project-dep-update-20260413T141800
base_branch=main
created_at=2026-04-13T14:18:00Z
branches=dep-updates/npm-commander,dep-updates/npm-express,dep-updates/py-requests
prs=45,46,47
```

Read with `grep "^key=" | cut -d= -f2-`; updated with `sed -i`.

> `.dep-update-state` is appended to `.gitignore` automatically if not already present.

### Cleanup

Runs automatically at end of update mode, or on demand via `dep-update --cleanup`:

```
→ Read .dep-update-state
→ For each PR number:
     gh pr view <N> --json state --jq '.state'
     poll every 60 s until state == "MERGED" | "CLOSED"
     (no timeout — merge timing is user-controlled)
→ git -C "$project_root" worktree remove --force "$worktree_path"
→ For each branch: git -C "$project_root" branch -d <branch>
→ rm "$project_root/.dep-update-state"
→ log "✓ Worktree cleaned up. All branches removed."
```

> `gh pr view --json state --jq` uses `gh`'s built-in `--jq` flag — not standalone `jq`.
> This is within the bash+gh+gt tooling constraint.

---

## Full Execution Flow

### Dry-run

```
dep-update --dry-run

→ check_core_prereqs  (git only; skip gt/gh auth)
→ detect_ecosystem
→ check_ecosystem_prereqs
→ npm: pnpm outdated | awk 'NR>2 {print $1, $2, $4}'
→ py:  pip list --outdated --format=columns | awk 'NR>2 {print $1, $2, $3}'
→ print formatted table to stderr
→ exit 0  # zero side effects, no worktree
```

### Update mode

```
dep-update

 1. parse_args
 2. check_core_prereqs      # git, gt, gh — must exist before anything else
 3. check_auth_prereqs      # gh auth status, gt auth
 4. detect_ecosystem        # sets has_npm=1/0, py_tool=uv|poetry|pipenv|pip|""
 5. check_ecosystem_prereqs # pnpm / uv / poetry / pipenv / pip — all reported at once
 6. assert_clean_workdir    # git diff --quiet && git diff --cached --quiet
 7. collect outdated pkgs   # store as "name current latest" lines in variables
 8. exit 0 if none found

 9. create_worktree         # git worktree add <path> main
10. ensure_gt_tracked       # gt branch info; if untracked: gt track -p main
11. write_state             # .dep-update-state: worktree path
12. ensure_gitignore        # append .dep-update-state to .gitignore if missing

13. for each package:
      a. apply_update       # pnpm update / uv add / poetry add / pip install
      b. git add <files>    # only manifest + lock file
      c. gt create dep-updates/<eco>-<pkg> -m "chore(deps): bump <pkg> from <old> to <new>"
      d. gt submit --no-interactive
      e. extract PR number: gh pr view --json number --jq '.number'
      f. write_pr_body      # write to /tmp/dep-update-pr-<pkg>.md
      g. gh pr edit <N> --title "..." --body-file /tmp/dep-update-pr-<pkg>.md
      h. append branch + PR to state file
      i. wait_for_ci        # unless --no-wait-ci

14. print_summary           # table: package / from / to / PR / CI status

15. if --no-wait-merge:
      log "Run: dep-update --cleanup --dir $project_root"
      exit 0

16. cleanup                 # poll PRs for merge; remove worktree + branches + state
```

---

## Per-Package File Changes

| Ecosystem | Files staged |
|---|---|
| npm/pnpm | `package.json` `pnpm-lock.yaml` |
| uv | `pyproject.toml` `uv.lock` |
| poetry | `pyproject.toml` `poetry.lock` |
| pipenv | `Pipfile` `Pipfile.lock` |
| pip | `requirements.txt` (or `pyproject.toml`) |

---

## Branch & Commit Naming

**Branch:** `dep-updates/<eco>-<sanitized-name>`
**Commit:** `chore(deps): bump <pkg> from <old> to <new>`

Sanitization (`sanitize_branch_name`):
- `@`, `/`, `_`, `.` → `-`
- Collapse consecutive `-`
- Lowercase

Examples:
```
dep-updates/npm-commander
dep-updates/npm-types-node        # @types/node
dep-updates/py-typing-extensions
```

---

## CI Polling (`wait_for_ci`)

```bash
wait_for_ci() {
  local -r branch="$1"
  local -r timeout_min=20
  local elapsed=0

  log "Waiting for CI on ${branch}…"
  while true; do
    local status
    status=$(gh run list --branch "$branch" --limit 1 --json conclusion --jq '.[0].conclusion // "pending"')

    case "$status" in
      success)  log "CI passed on ${branch}."; return 0 ;;
      failure|cancelled|timed_out)
                die "CI failed on ${branch} (${status}). Fix and re-run." ;;
      *)        : ;;  # pending / in_progress — keep waiting
    esac

    sleep 30
    elapsed=$(( elapsed + 1 ))
    if (( elapsed * 30 >= timeout_min * 60 )); then
      die "CI timed out after ${timeout_min} min on ${branch}."
    fi
  done
}
```

Uses `gh run list --json ... --jq` (gh-native flag, not standalone jq).

---

## PR Description

Written to `/tmp/dep-update-pr-<sanitized-pkg>.md`, applied via:

```bash
gh pr edit "$pr_num" --title "chore(deps): bump $pkg from $old to $new" \
                     --body-file "/tmp/dep-update-pr-${sanitized}.md"
```

Template:

```markdown
## Stack Context

Automated dependency updates via `dep-update`.
Each PR bumps exactly one dependency. Merge the full stack to update all.

## Why?

`<package>` has a newer version available.

- **From:** `<current>`
- **To:** `<latest>`
- **Ecosystem:** <npm | python/uv | python/poetry | python/pip>
- **Files changed:** <package.json + pnpm-lock.yaml | pyproject.toml + uv.lock | …>
```

---

## Shell Standards (AGENTS.md)

- No `.sh` extension; `#!/usr/bin/env bash` shebang
- `set -euo pipefail` at top
- Script-level constants: **lowercase** + `readonly`; declared and assigned **separately** from `$()` (SC2155)
- Function locals: `local` + separate assignment for `$()`, `local -r` for literals/params
- **No** `local -r var=$(cmd)` — SC2155 violation
- All output to **stderr** via `log()` / `die()`; stdout reserved for machine use if needed
- No `eval`; no `exec` with user-controlled input
- `shellcheck` SC2-clean — zero warnings
- Missing-tool errors are **always batched** — collect all failures, then call `die()` once

---

## Script Structure

```
parse_args()
usage()
log()                         # stderr, [dep-update] prefix
die()                         # log + exit 1

# Phase 1 prereqs
check_core_prereqs()          # git, gt, gh — existence only
check_auth_prereqs()          # gh auth status + gt auth (skipped in --dry-run)

# Ecosystem
detect_ecosystem()            # sets has_npm, py_tool
check_ecosystem_prereqs()     # pnpm / uv / poetry / pipenv / pip — batched errors

assert_clean_workdir()

# Worktree
create_worktree()             # git worktree add <path> main
ensure_gt_tracked()           # gt track -p main if needed
write_state()                 # write/update .dep-update-state
read_state()                  # parse state file (grep + cut)
ensure_gitignore()            # append .dep-update-state if missing

# npm
npm_outdated()                # pnpm outdated | awk -> "name current latest" lines
npm_update_one()              # pnpm update, git add, gt create, gt submit, gh pr edit

# python
py_outdated()                 # tool-specific | awk -> "name current latest" lines
py_update_one()               # tool update + lock, git add, gt create, gt submit, gh pr edit

# shared
sanitize_branch_name()        # @/_.  -> -, lowercase, collapse --
wait_for_ci()                 # gh run list poll; 20 min timeout
write_pr_body()               # write /tmp/dep-update-pr-<pkg>.md
print_summary()               # final table

# cleanup
poll_until_merged()           # gh pr view --json state --jq; 60 s interval
cleanup()                     # worktree remove + branch -d + rm state

main()
```

---

## Files Changed in This Repo

| File | Change |
|---|---|
| `scripts/dep-update` | **[NEW]** The script |
| `scripts/dep-update.plan.md` | **[NEW]** This plan |
| `package.json` | Extend `lint` script: `shellcheck scripts/fpdf scripts/dep-update` |
| `.gitignore` | Script appends `.dep-update-state` automatically at runtime |

---

## Verification Plan

### Automated (shellcheck)

```bash
shellcheck scripts/dep-update    # zero warnings
pnpm run lint                     # picks it up via package.json
```

### Manual — dry-run (safe, no worktree)

```bash
scripts/dep-update --dry-run
scripts/dep-update --dry-run --ecosystem npm
```

Expected: prints outdated-package table, exits 0, no git changes.

### Manual — full run (worktree lifecycle)

1. Clean working tree verified before start
2. Worktree appears as sibling to project root
3. `gt ls` inside worktree shows stack rooted on `main`
4. Each PR touches only its own manifest + lock file (verify via `gh pr diff`)
5. CI polling waits between PRs — visible in log output
6. After merge: `--cleanup` removes worktree, branches, state file
7. `git worktree list` confirms worktree is gone
8. `git branch` confirms dep-update branches are deleted
