# Runbook: backup and restore

The restore path runs on every push. See the `restore` job in
[`.github/workflows/ci.yml`](../../.github/workflows/ci.yml), which seeds a database, backs it
up, deletes the file and both sidecars, restores it and then checks the records and the schema
version. If that tick is green, the commands below worked this morning.

Everything here runs on the machine holding the database. There is no HTTP endpoint for either
half and there will not be one: a route that hands out a copy of the database hands out every
account's data to whoever finds a way to call it.

## What a backup is here

`VACUUM INTO`, never a file copy.

A running SQLite database in WAL mode is not its file. Committed data is split between
`portionium.db` and `portionium.db-wal` until a checkpoint moves it, so `cp portionium.db
elsewhere` copies a prefix of the truth, takes no lock, and can catch a page mid-write. That
copy usually opens, which is what makes it dangerous: you find out on the day you need it.

This is not a theoretical worry. On a container that has just started and seeded the catalog,
`portionium.db` is 4 KB and `portionium.db-wal` is 358 KB: almost the entire database is in the
WAL, and a copy of the `.db` file alone would be a working, nearly empty database.

`VACUUM INTO` runs inside a read transaction and writes a complete, freshly packed database. It
blocks no reader, delays a writer by a moment, and what lands stands on its own with no sidecars
to remember. The code is [`api/src/db/backup.ts`](../../api/src/db/backup.ts).

## Taking one

The application takes one itself when `BACKUP_DIR` is set, at startup and hourly after that,
skipping unless the newest archive is older than `BACKUP_INTERVAL_HOURS`. The container sets
`BACKUP_DIR=/data/backups`. An instance with no `BACKUP_DIR` says so at startup, at warn.

By hand, against a running instance or a stopped one:

```sh
pnpm --filter @portionium/api backup create
pnpm --filter @portionium/api backup list
```

In the container, which ships the compiled command and whose working directory is `/app/api`:

```sh
docker compose exec app node dist/cli/backup.js create
docker compose exec app node dist/cli/backup.js list
```

Archives are named `portionium-<UTC timestamp>.db.gz`. The timestamp is in the name because an
mtime does not survive a copy to object storage or an `rsync` somebody forgot the `-a` on, and
the name is what the retention policy reads.

Retention is grandfather-father-son, `BACKUP_KEEP_DAILY`, `_WEEKLY` and `_MONTHLY`, applied
after each backup. An archive counts in every tier it is the newest of, so the defaults keep
about eleven files rather than fourteen: a week of daily detail, a couple of older weeks, the
last day of the previous months. Files the app did not write are never touched, so a copy you
park in that directory under another name is safe.

## Restoring

**Stop the application first.** Restoring onto a live database is how a bad afternoon becomes a
worse one, and the command refuses an existing target unless `--force`.

```sh
docker compose down                      # or: systemctl stop portionium
pnpm --filter @portionium/api backup restore --from data/backups/portionium-20260912T143000Z.db.gz
docker compose up -d
```

`--to` overrides the target, which defaults to `DATABASE_PATH`. Restore somewhere else first if
you want to look at an archive before committing to it:

```sh
pnpm --filter @portionium/api backup restore \
  --from data/backups/portionium-20260912T143000Z.db.gz --to /tmp/check.db
```

The command does four things a `gunzip` does not, and reports rather than assumes:

1. Unpacks to a staging file beside the target and moves it into place only once the checks below
   have passed, so **a failed restore leaves the target exactly as it was**. Unpacking straight
   onto the path creates the file before the first byte is read, so a mistyped archive name or a
   full disk would leave an empty database where the real one was, and the next start would
   migrate that into a working, blank instance. A restore that turns into a fresh install is the
   worst outcome available here.
2. Removes the target's `-wal` and `-shm` sidecars as it moves the new file in. They belong to
   the file that used to be there, and SQLite applies those pages on top of a restored database.
   That is the other way this operation loses data quietly.
3. Runs `integrity_check`, which reads every page and index rather than trusting that the file
   opens, and opens it the way the application does, so migrations this build ships are applied
   here rather than on the next boot.
4. Prints the migration count, and exits non-zero on any of the above. A silent failure is the
   thing this whole module exists to prevent.

After starting up, `GET /ready` is the independent confirmation: it answers 200 only when the
file responds and its schema matches the build.

## Rolling back a bad migration

There are no down migrations, by decision, see the Database section of
[AGENTS.md](../../AGENTS.md). The recovery path is this runbook plus the previous image:

```sh
docker compose down
pnpm --filter @portionium/api backup restore --from <archive from before the deploy> --force
# pin the previous tag in docker-compose.yml or .env.docker, then
docker compose up -d
```

Restore before rolling the image back, not after: the old build refuses to start against a
schema newer than the migrations it ships, which is `/ready` doing its job.

## What is in an archive

Every account's food and weight history, and the credential rows: password hashes, session token
digests and API token digests. Hashes and digests rather than anything reusable, see the
Authentication section of [AGENTS.md](../../AGENTS.md), so a stolen archive is not a set of live
sessions and is not somebody's password. It is still everybody's diary, so an archive deserves
the same care as the database: `600`, and not in a public bucket.

Rotating a credential does not reach back into archives, by definition. If one has to be treated
as compromised, the order is in [SECURITY.md](../../SECURITY.md): rotate first, then decide what
to do about copies.

## Getting a copy off the machine

Not configured by default and deliberately so. `BACKUP_DIR` on the same volume as the database
survives the container, the image and a bad migration, which is what actually goes wrong on a
home deployment. It does not survive the disk or the house.

The archives are plain gzipped files with timestamps in their names, so anything that copies
files will do, and there is no code here for it:

```sh
# rclone to any of the forty-odd providers it speaks, on a timer
0 4 * * * rclone copy /var/lib/portionium/backups remote:portionium-backups --max-age 48h

# or restic, if you want the off-machine copy deduplicated and encrypted
0 4 * * * restic -r s3:... backup /var/lib/portionium/backups
```

Two things to get right if you do this. Copy the archives and never the live `portionium.db`,
for the reason at the top of this page. And restore one of the off-machine copies occasionally:
a copy that has never come back is exactly the hope this page exists to replace.
