# Running fpdf as a systemd User Service

This guide covers how to install, manage, and troubleshoot fpdf as a
persistent background service using systemd's user session support.

The service runs under your user account (no root required), starts on boot
via lingering, and is managed using the `setup-service` script from
[repository-helpers](https://github.com/the-hcma/repository-helpers).

## Prerequisites

- systemd user session available (`systemctl --user status` returns output)
- `~/work/ai/repository-helpers` cloned locally
- fpdf dependencies installed (`pnpm install`)

## Install the Service

Run `setup-service` from the fpdf repo directory:

```bash
~/work/ai/repository-helpers/scripts/setup-service
```

This will:

1. Read `etc/systemd/fpdf.service` from the repo, substitute `@@REPO_DIR@@`
   with the actual repo path, and write the result to
   `~/.config/systemd/user/fpdf.service`.
2. Create the log directory at `~/scratch/fpdf/`.
3. Enable systemd lingering so the service starts on boot without a login session.
4. Run `scripts/on-deploy` — rebuilds `dist/` if the git SHA has changed.
5. Enable and start (or restart) the service.

## Check Status

```bash
~/work/ai/repository-helpers/scripts/setup-service --status
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
~/work/ai/repository-helpers/scripts/setup-service
```

At the start of each development session, `start-development --refresh`
handles this automatically:

```bash
~/work/ai/repository-helpers/scripts/dev/start-development --refresh
```

## Service Configuration

The service template lives at
[etc/systemd/fpdf.service](../etc/systemd/fpdf.service).

Key settings:

| Setting          | Value                                                                       |
|------------------|-----------------------------------------------------------------------------|
| `ExecStart`      | `scripts/fpdf --yes --listen-all --port 8002`                               |
| `ExecStartPost`  | polls `http://127.0.0.1:8002/health` (12 × 1 s) to confirm startup         |
| `Restart`        | `always`                                                                    |
| `RestartSec`     | `5s`                                                                        |
| `StandardOutput` | `append:~/scratch/fpdf/fpdf.log`                                            |
| `WantedBy`       | `default.target` (user session)                                             |

To change startup flags (e.g. a different port), edit
`etc/systemd/fpdf.service` and re-run `setup-service`.

## Uninstall

```bash
systemctl --user stop    fpdf
systemctl --user disable fpdf
rm ~/.config/systemd/user/fpdf.service
systemctl --user daemon-reload
```
