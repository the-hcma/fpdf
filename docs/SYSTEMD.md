# Running fpdf as a systemd User Service

The unit **template** (with `@@REPO_DIR@@`) lives in this repo at `etc/systemd/fpdf.service`. `setup-service` from [repository-helpers](https://github.com/the-hcma/repository-helpers) expands it into `~/.config/systemd/user/` and mirrors the expanded unit under `~/.config/share/systemd-units/`.

## Prerequisites

- systemd user session (`systemctl --user status` works)
- [repository-helpers](https://github.com/the-hcma/repository-helpers) cloned locally
- `pnpm install` completed in this repo
- `~/.config/user-services-host` — short hostname label for the service host (or pass `--condition-host` on first setup)
- `~/.config/user-services-host-fqdn` — FQDN on the service host (or `--condition-host-fqdn`)
- `~/.config/user-services-machine-id` — machine-id from `/etc/machine-id`; setup injects `ConditionHost=|` guards (see repository-helpers `docs/SYSTEMD.md`)

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

## Hardening

The unit sets `NoNewPrivileges=true`, `ProtectSystem=full` (read-only `/usr`, `/boot` and `/etc`) and `RestrictAddressFamilies=AF_INET AF_INET6 AF_NETLINK AF_UNIX` (HTTP, the interface listing and `ss`, which finds the process already holding the port, and local IPC; raw packet sockets are not used) and `SystemCallArchitectures=native`.

`NoNewPrivileges` is enforced everywhere. `RestrictAddressFamilies` is enforced on x86-64 and aarch64 but ignored on 32-bit x86, s390, s390x, mips and ppc ABIs, and it does not cover 32-bit calls on a host that also runs 32-bit x86 code, so it is paired with `SystemCallArchitectures=native`. `ProtectSystem` needs a mount namespace, which a user manager builds inside an unprivileged user namespace. Where that is not allowed (`kernel.apparmor_restrict_unprivileged_userns=1`, the default on recent Ubuntu; observed on Ubuntu 24.04 with systemd 255), systemd starts the unit without it and without an error, so `systemctl --user show` reports it as set even though it does nothing. To see what a unit really gets, run `readlink /proc/self/ns/mnt` inside a transient unit (`systemd-run --user --wait --pipe -p ProtectSystem=full readlink /proc/self/ns/mnt`) and compare it with the same command in your shell: the same value means no mount namespace.

`ProtectHome`, `PrivateTmp` and `ProtectSystem=strict` stay off on purpose: the server browses the home directory and saves next to the source PDF wherever the user chose, which can be `/tmp`. `SystemCallFilter=` stays off because it can break a service at runtime.

Before adding a directive, run the real server under it in an isolated transient unit on another port and check `/health`, `/browse` and an upload:

```bash
systemd-run --user --collect --unit=fpdf-probe -p NoNewPrivileges=true -p ProtectSystem=full \
  -p "RestrictAddressFamilies=AF_INET AF_INET6 AF_NETLINK AF_UNIX" -p SystemCallArchitectures=native -p RuntimeMaxSec=300 -p WorkingDirectory="$PWD" \
  -E PATH="$PATH" -E HOME="$HOME" "$PWD/scripts/fpdf" --yes --port 18082
```

`systemd-run` returns while the probe keeps running, so stop it when you are done (`systemctl --user stop fpdf-probe`) before starting another run under the same name; the `RuntimeMaxSec` above is a safety net, and `--collect` makes systemd forget the unit even when it times out or crashes (without it a failed probe stays loaded and the same name cannot be reused until `systemctl --user reset-failed`).

If a host does enforce the mount namespace but the unit fails with `status=226/NAMESPACE`, set `ProtectSystem=no` in a drop-in (`systemctl --user edit fpdf`), which survives a `setup-service` reinstall, instead of editing the shipped unit. `src/__tests__/systemd-unit.test.ts` pins the directives and the ones that must stay off.

## Uninstall

```bash
systemctl --user disable --now fpdf
rm ~/.config/systemd/user/fpdf.service
rm -f ~/.config/share/systemd-units/fpdf.service
systemctl --user daemon-reload
```
