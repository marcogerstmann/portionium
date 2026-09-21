---
id: ADR-009
title: 'Hosting model and deployment target'
status: Accepted
date: 2026-09-12
---

## Context

The application has run locally since the first commit. Making it reachable from a phone forces a
decision that several earlier ones have already constrained.

SQLite is the whole persistence layer ([ADR 001](./001-sqlite-over-postgresql.md)), so there is one
file, one writer, and a need for a real disk that survives a restart. The rate limiter and the
login lockout are counters in process memory ([ADR 005](./005-no-redis-no-metrics-stack.md)), so
they mean something only while one long-lived process is serving. Backups are an hourly timer
inside that same process, so a host that stops the process when nobody is looking stops taking
them. And the client is a PWA, which a browser refuses to install over plain http.

Together those rule out every platform whose cheapness comes from scaling to zero or spreading
requests over several instances. What is left is one always-on container with a persistent disk and
a certificate. The second question is how that machine comes to exist: by hand, or through
infrastructure as code.

## Decision

One Hetzner Cloud **CX23** in Falkenstein, Ubuntu LTS, running the published image with Docker
Compose and the `caddy` profile already in this repository. Roughly 6 euro a month including the
IPv4 address.

The hostname resolves straight to that address, with any CDN proxy in front of the DNS left
**disabled**, so Caddy terminates TLS with its own Let's Encrypt certificate and the address the
application sees is the client's rather than an edge node's.

The machine is **created by hand and configured by a committed file**, not by Terraform, Pulumi or
Ansible. [`infra/cloud-init.example.yaml`](../../infra/cloud-init.example.yaml) describes the
inside of the box and [`docs/runbooks/deploy.md`](../runbooks/deploy.md) holds the commands that
create it, so both halves are reviewable text with no state to reconcile. Only this record names a
provider: cloud-init is a format every cloud image understands, so that file is portable as
written, and the runbook is generic with one worked Hetzner example in the single step that cannot
be.

The running version is pinned by `PORTIONIUM_TAG` in the server's `.env` rather than tracking
`:latest`, so which release is running is a fact about a file instead of a question about when
somebody last pulled.

## Consequences

Deployment is `docker compose pull && docker compose up -d`, and an image rollback is editing one
variable and running it again. Nothing in the repository had to change to support the host: the
Dockerfile, the Compose file and the Caddyfile were already the deployment. The costs:

- **The host is ours to patch.** Paid for in the cloud-init rather than in attention: unattended
  upgrades reboot at half past four, every service restarts unless stopped, and Docker's log driver
  is capped so an unwatched box cannot fill its disk with its own request log.
- **A few seconds of downtime on every deploy.** One SQLite file means one container, which means
  no rolling restart, which is the same constraint that makes the whole thing cheap.
- **An image rollback only covers additive migrations.** There are no down migrations by decision,
  so a destructive one is recovered by restoring an archive and then downgrading, in that order.
  That path is written down in [backup.md](../runbooks/backup.md) and runs in CI on every push.
- **The instance is a pet with a local disk and no replication.** Losing the machine loses the
  database and every archive on it together, which is why an off-machine copy is a documented cron
  rather than an optional nicety.

Hetzner is a German company and the data is a household's food and weight history, which is the
best available answer for a project with no legal entity behind it.

## Options considered

**A platform with an attached volume, Fly.io being the concrete one.** Costs about the same once
configured honestly. `auto_stop_machines` has to be off, because a sleeping machine takes no
backups and resets the lockout counters on every wake, and that setting is the reason to choose Fly
in the first place. One volume still means one machine and no rolling deploys. Volumes are
documented as single-host and not redundant, so durability is no better than a VPS disk while
recovery gets longer, since restoring means `fly ssh` and `fly sftp` rather than a file on a box
already open in a terminal.

**A home device behind Tailscale.** Free, and the strongest privacy answer. Rejected because it is
not reachable by somebody who has not been added to a tailnet, and handing over a URL was the
reason for deploying at all. Still the better answer the day this stops needing to be demonstrated:
the same Compose file runs on a Raspberry Pi, which is why the image is still built for arm64.

**A home device plus a Cloudflare Tunnel.** Publicly reachable and free, and it does clear the bar
the previous option fails. Rejected because TLS terminates at Cloudflare, so a third party sees the
plaintext of a health diary, and because uptime becomes a domestic internet connection.

**Terraform, OpenTofu or Pulumi for the machine.** The infrastructure is a server, a firewall, an
SSH key and a DNS record, created once. A state file describing four resources would be the most
fragile thing in the stack and would need a backend and a credential of its own. None of those
tools configures the inside of the box, so cloud-init would exist anyway. Worst of all, the
declarative model wants to replace a server it finds unsatisfactory, and replacing this one
destroys the disk holding the database, so it would have to be marked protected, which is the tool
admitting it cannot do the thing it is for.

**Deploying from CI.** It would trade two commands run about once a month for a credential in
GitHub that can open a shell on the production box.

## What would make us revisit this

- **A second environment.** Staging means two of everything and drift between them, which is where
  infrastructure as code starts paying immediately. OpenTofu with the `hcloud` provider at that
  point, not Pulumi, because it is what a reader recognises.
- **A third person, or a second box.** Manual provisioning stops being reasonable roughly when the
  runbook stops fitting on one page.
- **Outgrowing one SQLite file**, which is [ADR 001](./001-sqlite-over-postgresql.md)'s own revisit
  condition and the only reason the platform options lost on mechanics rather than preference.
- **Downtime during deploys starting to matter.** It does not at two users, and it would mean a
  second instance, which means a database that supports one, which is the previous point again.
