# Running fpdf as a systemd User Service

This guide covers how to install, manage, and troubleshoot fpdf as a
persistent background service using systemd's user session support.

The service runs under your user account (no root required), starts on boot
via lingering on the designated **ConditionHost**, and is managed using
`setup-service` from
[repository-helpers](https://github.com/the-hcma/repository-helpers).

Unit templates live in **repository-helpers**
`share/systemd-unit-templates/` (not in this repo). Optional local overrides
may be placed in gitignored `etc/systemd/`.

## Prerequisites

- systemd user session available (`systemctl --user status` returns output)
- [`repository-helpers`](https://github.com/the-hcma/repository-helpers) cloned locally
- `REPO_HELPERS` set to its path (optional convenience): `export REPO_HELPERS=/path/to/repository-helpers`
- fpdf dependencies installed (`pnpm install`)
- `~/.config/user-services-host` set to your service host (or pass
  `--condition-host` on first `setup-service` run)

## Install the Service

Run `setup-service` from the fpdf repo directory:

```bash
$REPO_HELPERS/scripts/setup-service
```

This will:

1. Read `share/systemd-unit-templates/fpdf.service` from repository-helpers,
   substitute `@@REPO_DIR@@`, inject `ConditionHost=`, and write the result to
   `~/.config/systemd/user/fpdf.service`.
2. Create the log directory at `~/scratch/fpdf/`.
3. Enable systemd lingering on the ConditionHost machine.
4. Run `scripts/on-deploy` — rebuilds `dist/` if the git SHA has changed.
5. Enable and start (or restart) the service on the ConditionHost only.

## Check Status

```bash
$REPO_HELPERS/scripts/setup-service --status
```

Or use systemctl directly:

```bash
systemctl --user status fpdf
```

## View Logs

Logs are written to `~/scratch/fpdf/fpdf.log`:

```bash
# Follow live
tail -f ~/scratch/fpdf/fpdf.log

# Last 100 lines via journal
journalctl --user -u fpdf -n 100

# Follow live via journal
journalctl --user -u fpdf -f
```

## Start / Stop / Restart Manually

```bash
systemctl --user start   fpdf
systemctl --user stop    fpdf
systemctl --user restart fpdf
```

## Update After Code Changes

Run `setup-service` again — it re-runs `on-deploy` (which rebuilds `dist/` if
the git SHA changed) and restarts the service only when necessary:

```bash
$REPO_HELPERS/scripts/setup-service
```

At the start of each development session, `start-development --refresh`
handles this automatically:

```bash
$REPO_HELPERS/scripts/dev/start-development --refresh
```

## Service Configuration

The canonical template is
[repository-helpers/share/systemd-unit-templates/fpdf.service](https://github.com/the-hcma/repository-helpers/blob/main/share/systemd-unit-templates/fpdf.service).

Key settings:

| Setting          | Value                                                                       |
|------------------|-----------------------------------------------------------------------------|
| `ExecStart`      | `scripts/fpdf --yes --listen-all --port 8002`                               |
| `ExecStartPost`  | polls `http://127.0.0.1:8002/health` (12 × 1 s) to confirm startup         |
| `Restart`        | `always`                                                                    |
| `RestartSec`     | `5s`                                                                        |
| `StandardOutput` | `append:~/scratch/fpdf/fpdf.log`                                            |
| `WantedBy`       | `default.target` (user session)                                             |

To change startup flags (e.g. a different port), edit the template in
repository-helpers (or a local gitignored `etc/systemd/fpdf.service` override)
and re-run `setup-service`.

## Uninstall

```bash
systemctl --user stop    fpdf
systemctl --user disable fpdf
rm ~/.config/systemd/user/fpdf.service
systemctl --user daemon-reload
```
