# Running fpdf as a systemd User Service

The unit **template** (with `@@REPO_DIR@@`) lives in this repo at
`etc/systemd/fpdf.service`. `setup-service` from
[repository-helpers](https://github.com/the-hcma/repository-helpers) expands it
into `~/.config/systemd/user/` and mirrors the expanded unit under
`~/.config/share/systemd-units/`.

## Prerequisites

- systemd user session (`systemctl --user status` works)
- [repository-helpers](https://github.com/the-hcma/repository-helpers) cloned locally
- `pnpm install` completed in this repo
- `~/.config/user-services-host` — short hostname label for the service host (or pass
  `--condition-host` on first setup)
- `~/.config/user-services-host-fqdn` — FQDN on the service host (or `--condition-host-fqdn`)
- `~/.config/user-services-machine-id` — machine-id from `/etc/machine-id`; setup injects
  `ConditionHost=|` guards (see repository-helpers `docs/SYSTEMD.md`)

## Install

From this repo:

```bash
~/work/ai/repository-helpers/scripts/setup-service
```

## Status, logs, manual control

```bash
~/work/ai/repository-helpers/scripts/setup-service --status
tail -f ~/scratch/fpdf/fpdf.log
systemctl --user restart fpdf
```

## Configuration

Edit `etc/systemd/fpdf.service` and re-run `setup-service`.

## Uninstall

```bash
systemctl --user disable --now fpdf
rm ~/.config/systemd/user/fpdf.service
rm -f ~/.config/share/systemd-units/fpdf.service
systemctl --user daemon-reload
```
