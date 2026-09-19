#!/bin/sh
# Fetch the newest Portionium backup archive into ~/Downloads, taking a fresh one first.
#
#   scripts/fetch-backup.sh                      # ssh portionium, create, download newest
#   scripts/fetch-backup.sh --no-create          # download the newest that is already there
#   scripts/fetch-backup.sh --no-create vps /tmp # another host, another directory
#
# The archives live in the container's /data volume, which on the host is root owned, so the
# commands go through `docker exec` and the file is streamed over ssh rather than scp'd.
# See docs/runbooks/backup.md.
set -eu

create=1
if [ "${1:-}" = "--no-create" ]; then
  create=0
  shift
fi

host=${1:-portionium}
dest=${2:-$HOME/Downloads}

# An archive is everybody's diary plus the credential rows. 600 from the moment it exists.
umask 077

container=$(ssh "$host" 'docker ps -qf name=portionium-app' | head -n 1)
if [ -z "$container" ]; then
  echo "No running portionium container on $host." >&2
  exit 1
fi

if [ "$create" = 1 ]; then
  ssh "$host" "docker exec $container node dist/cli/backup.js create"
fi

# Names are UTC timestamps, so the last one lexically is the newest one.
archive=$(ssh "$host" "docker exec $container sh -c 'ls -1 /data/backups/portionium-*.db.gz 2>/dev/null' | tail -n 1" || :)
if [ -z "$archive" ]; then
  echo "No archives in /data/backups on $host." >&2
  exit 1
fi

name=$(basename "$archive")
ssh "$host" "docker exec $container cat '$archive'" > "$dest/$name.part"
# A dropped connection leaves a plausible truncated file otherwise.
gzip -t "$dest/$name.part"
mv "$dest/$name.part" "$dest/$name"

echo "$dest/$name"
