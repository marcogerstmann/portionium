# portionium

Track food by energy density, not calories. Self hosted food and weight journal for a household.

## Run it

One container serves the API and the web client on one origin. Docker and the Compose plugin
are the only things you need installed.

```sh
git clone git@github.com:marcogerstmann/portionium.git
cd portionium
docker compose up -d
```

That builds the image, applies the migrations, loads the food catalog and starts on
**http://localhost:8080**. Nothing to edit first, no `.env` to copy.

There is no sign up, so make the first account. It is an admin, because there is nobody to have
granted it one:

```sh
docker compose exec app node dist/cli/user.js create \
  --email you@example.com --name "Your Name" --timezone Europe/Berlin
```

The password is asked for at the prompt rather than taken as an argument, so it stays out of
your shell history. Then sign in at http://localhost:8080.

The database is a single SQLite file on the `portionium_data` volume. It survives
`docker compose down`, a rebuild and an upgrade.

### Backups

The container backs itself up. Daily, to `/data/backups` on the same volume, with `VACUUM INTO`
rather than a file copy, keeping seven daily archives, four weekly and three monthly. Nothing to
configure.

**The restore path is exercised on every push.** The
[`restore` job in CI](https://github.com/marcogerstmann/portionium/actions/workflows/ci.yml)
seeds a database, backs it up through the documented command, deletes the file and both its
sidecars, restores it through the documented command, and then asserts that the account, the
meal, the row behind its foreign key, the shipped food catalog and the migration count all came
back. A backup nobody has restored is a hope, not a strategy, and the only honest way to know is
to destroy a database and bring it back.

Restoring one, rolling back a bad migration and getting a copy off the machine are in
[docs/runbooks/backup.md](./docs/runbooks/backup.md).

```sh
docker compose exec app node dist/cli/backup.js list
```

### Changing settings

Every variable and what it does is in [`.env.example`](./.env.example). To change one, put it in
a file called `.env.docker` next to the Compose file and restart. Anything you do not name keeps
the default baked into the image.

Two knobs belong to Compose rather than to the app, and are read from your environment or from
`.env`: `PORTIONIUM_PORT` (8080) and `PORTIONIUM_BIND` (`0.0.0.0`).

### On a domain, with https

A PWA is not installable over plain http: a browser refuses to register a service worker on an
insecure origin. The `caddy` profile puts Caddy in front, which gets a Let's Encrypt certificate
on the first request and renews it on its own.

Point the domain's A record at the machine, put `WEB_ORIGIN=https://food.example.com` in
`.env.docker`, then:

```sh
PORTIONIUM_DOMAIN=food.example.com PORTIONIUM_BIND=127.0.0.1 docker compose --profile caddy up -d
```

`PORTIONIUM_BIND=127.0.0.1` keeps the app off the public interface, so the only way in is
through the proxy. `WEB_ORIGIN` has to match what the browser sees: the session cookie's
`Secure` flag and the CSRF check both follow it, and leaving it on http means every write is
refused.

Released images are published to `ghcr.io/marcogerstmann/portionium`, built for amd64 and
arm64, so a VPS or a Raspberry Pi pulls rather than builds.

## Working on it

Start with [AGENTS.md](./AGENTS.md) for setup, layout and conventions.

[SECURITY.md](./SECURITY.md) is how to report a vulnerability, and the procedures for rotating a
password, ending every session and revoking API tokens. Worth reading before you need them.

The full README lands with the documentation story.
