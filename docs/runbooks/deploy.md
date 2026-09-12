# Runbook: deploying this on your own server

Follow this once and the app runs on your own domain, over https, backing itself up. It takes
about twenty minutes of work plus however long your provider needs to make a machine, and costs
around 6 euro a month to keep running.

It assumes you can use a terminal and own a domain. It does not assume you have deployed
anything before.

Examples below use `food.example.com`. Substitute your own hostname everywhere it appears.

## What you end up with

One small server running two containers. The app serves the API and the web client on one
origin, with its SQLite database on a Docker volume, and takes a backup of itself every hour.
Caddy sits in front and gets the certificate. Nothing else is installed on the machine.

## Before you start

| You need                                   | How to check                                |
| ------------------------------------------ | ------------------------------------------- |
| A domain, and access to its DNS            | You can add an `A` record                   |
| An SSH keypair                             | `ls ~/.ssh/id_ed25519.pub`                  |
| An account with a server provider          | Hetzner, DigitalOcean, Vultr, Scaleway, any |
| This repository cloned on your own machine | You are reading this file from it           |

The server itself needs Ubuntu LTS or another cloud image that speaks cloud-init, which is all of
them, 1 GB of RAM and up, 20 GB of disk and up, and **ports 80 and 443 reachable from the
internet**. That last one rules out a machine behind CGNAT or a router you do not control, which
is a different deployment shape entirely, see [ADR 009](../adr/009-hosting-and-deployment.md).

One gigabyte is genuinely enough: a password check takes 19 MiB for as long as it runs, the
process sits around a hundred megabytes, and everything above that becomes cache for the
database.

## The six steps

1. Publish a release image
2. Create the server
3. Point your domain at it
4. Start the app
5. Create your account
6. Check the things that matter

---

## Step 1: publish a release image

The server pulls a prebuilt image instead of compiling anything, so the image has to exist
first. Pushing a tag beginning with `v` is what builds and publishes it.

```sh
git tag v0.1.0
```

```sh
git push origin v0.1.0
```

Three to five minutes. The job called `image` is the one that matters:

```sh
gh run watch
```

Then make the package public: GitHub, your profile, Packages, `portionium`, Package settings,
Change visibility. Packages published by Actions start private, and a private one asks the server
for a password in step 4.

**Done when:** `docker pull ghcr.io/<your-username>/portionium:v0.1.0` works from your machine.

**Prefer to keep it private?** Fine. Run `docker login ghcr.io` on the server in step 4, with a
token carrying `read:packages` and nothing else.

## Step 2: create the server

### 2a. Decide which SSH keys may log in

[`infra/cloud-init.example.yaml`](../../infra/cloud-init.example.yaml) is the machine's
configuration. Copy it, the same way you would copy `.env.example`:

```sh
cp infra/cloud-init.example.yaml infra/cloud-init.yaml
```

Open your copy and replace the placeholder key with your own public key, which is the only line
you change:

```sh
ls ~/.ssh/*.pub
```

**Note which file you use.** The key you paste here is the only one that will open the server, so
if it is not the one your client offers by default, every login is refused with
`Permission denied (publickey)` and the machine looks broken when it is not. Adding the host to
`~/.ssh/config` when you first connect is the cure, see the end of step 2b.

Your copy is gitignored, so it cannot be committed by accident, and the committed example keeps a
placeholder that fails rather than one that quietly works for whoever wrote it. A public key is
not a secret, but a default that opens somebody else's server is still the wrong default.

**What that file is.** cloud-init is the standard way a cloud server configures itself on first
boot. The image already contains it, the provider hands it your file as **user data**, and it
runs once. Nothing in this project reads it. It installs Docker, creates a `deploy` user carrying
your keys, turns off root and password logins, caps Docker's log files so the disk cannot fill up
unattended, and lets security updates reboot the machine at 04:30 UTC.

**No keypair yet?** `ssh-keygen -t ed25519` makes one. And if you would rather pull your keys off
GitHub than paste one, `ssh_import_id: [gh:your-handle]` replaces the `ssh_authorized_keys` block;
the comments in the file cover what that costs.

### 2b. Create it

At any provider: Ubuntu LTS, the smallest instance meeting the requirements above, your SSH key,
a firewall allowing 22, 80 and 443, and your `infra/cloud-init.yaml` as the user data. In a web
console that last one is a field called **user data** or **cloud config**, and you paste the
file's contents in.

Worked example, Hetzner from the command line. Install with `brew install hcloud`, then
`hcloud context create portionium` and paste a token made in that project:

```sh
hcloud firewall create --name portionium
```

```sh
for p in 22 80 443; do \
  hcloud firewall add-rule portionium --direction in --protocol tcp --port $p \
    --source-ips 0.0.0.0/0 --source-ips ::/0; \
done
```

```sh
hcloud ssh-key create --name laptop --public-key-from-file ~/.ssh/<the key you pasted>.pub
```

This one only ever reaches `root`, which the cloud-init disables, so it changes nothing about how
you log in. Providers insist on a key at creation, so give them the same one.

```sh
hcloud server create --name portionium --type cx23 --image ubuntu-24.04 --location fsn1 \
  --ssh-key laptop --firewall portionium --user-data-from-file infra/cloud-init.yaml
```

`cx23` is 2 vCPU, 4 GB and 40 GB of SSD for about 6 euro a month including the IPv4 address. Note
the addresses the command prints. The firewall is created first on purpose, so the server is
never up without one.

**Done when:** this prints `status: done`. SSH starts answering before cloud-init has finished
installing Docker, so waiting for it is not optional:

```sh
ssh -i ~/.ssh/<your key> deploy@<your-ipv4> cloud-init status --wait
```

`status: running` means keep waiting, not that something is wrong: Docker is still installing.
Save yourself the flag on every later command by adding the host to `~/.ssh/config`:

```
Host portionium
  HostName <your-ipv4>
  User deploy
  IdentityFile ~/.ssh/<your key>
  IdentitiesOnly yes
```

`IdentitiesOnly yes` is what stops your agent offering a different key first.

## Step 3: point your domain at it

Two records at your DNS provider, pointing at the addresses from step 2:

| Type   | Name                      | Value             |
| ------ | ------------------------- | ----------------- |
| `A`    | `food`, or your subdomain | the server's IPv4 |
| `AAAA` | the same name             | the server's IPv6 |

**If your DNS is at Cloudflare or another CDN, leave the proxy off.** On Cloudflare that is the
grey cloud rather than the orange one. Two reasons: Caddy has to answer on port 80 itself to get
a certificate, and this API trusts the `X-Forwarded-For` header, which is right behind the Caddy
on its own machine and wrong behind a proxy while the server is still directly reachable, because
anyone could then forge an address and hand themselves a fresh rate limit budget. Turning the
proxy on later is fine, but it means restricting port 443 to the CDN's address ranges in the same
sitting.

**Your provider probably gave you an IPv6 network, not an address.** Hetzner and most others
hand out a whole `/64`, and a `AAAA` record names one host, so pasting `2a01:…:ed8e::/64` is
rejected. The address you want is the one actually configured on the interface, conventionally
the first in the range:

```sh
ssh portionium ip -6 addr show scope global
```

**Done when:** `dig +short food.example.com` returns your server's address.

## Step 4: start the app

Log in and fetch the two files the server needs. It never builds anything, so this is the Compose
file and the Caddyfile rather than the source:

```sh
ssh deploy@<your-ipv4>
```

```sh
sudo git clone https://github.com/marcogerstmann/portionium.git /opt/portionium \
  && sudo chown -R deploy:deploy /opt/portionium
```

Now two small config files. They look similar and are not the same thing.

**`.env` is read by Docker Compose.** It decides how the containers are wired:

```sh
cd /opt/portionium && cat > .env <<'END'
PORTIONIUM_TAG=v0.1.0
PORTIONIUM_DOMAIN=food.example.com
PORTIONIUM_BIND=127.0.0.1
COMPOSE_PROFILES=caddy
END
```

| Variable            | What it does                                                                              |
| ------------------- | ----------------------------------------------------------------------------------------- |
| `PORTIONIUM_TAG`    | Which release runs. Changing it and restarting is both updating and rolling back          |
| `PORTIONIUM_DOMAIN` | The name Caddy requests a certificate for                                                 |
| `PORTIONIUM_BIND`   | `127.0.0.1` keeps the app off the public interface, so the proxy is the only way in       |
| `COMPOSE_PROFILES`  | Turns Caddy on, so every later command is a plain `docker compose` with no flag to forget |

**`.env.docker` is handed to the app itself.** One line is enough, everything else has a working
default baked into the image, including where the database and the backups live:

```sh
printf 'WEB_ORIGIN=https://food.example.com\n' > .env.docker && chmod 600 .env.docker
```

`WEB_ORIGIN` has to match what a browser sees, `https` included. The session cookie's `Secure`
flag and the CSRF check both follow it, so on a wrong value every write is refused.

Start it:

```sh
docker compose pull && docker compose up -d
```

**Done when:** `curl -sI https://food.example.com/health` answers `200` over a valid certificate.
Caddy asks for that certificate on the first request to the name, so give it a few seconds before
deciding something is wrong.

## Step 5: create your account

There is no sign up page. The first account is an admin, because there is nobody to have granted
it one. The password is typed at a prompt rather than passed as an argument, so it stays out of
your shell history and out of the process list:

```sh
docker compose exec app node dist/cli/user.js create \
  --email you@example.com --name "Your Name" --timezone Europe/Berlin
```

Repeat for everybody else in the household. Then sign in at `https://food.example.com`.

**Done when:** you are signed in and can log a meal.

## Step 6: check the things that matter

```sh
curl -s https://food.example.com/ready
```

`200` means the database answers and its schema is the one this build expects.

```sh
docker compose exec app node dist/cli/backup.js list
```

One archive, taken at startup. Hourly from then on, keeping seven daily, four weekly and three
monthly.

```sh
docker compose logs app | head -30
```

The resolved configuration, with anything secret masked, then one line per request.

Then three things by hand, because no command above proves them:

- **Install the app on a phone** from the deployed address and open it from the home screen. This
  is the entire reason the deployment needed a certificate.
- **Get a password wrong five times** and confirm you are refused with a `Retry-After`. That
  counter lives only in this process, so it is worth seeing once on the real machine.
- **Restore a backup**, following [backup.md](./backup.md). CI proves the commands work; only you
  can prove the archives on this machine are what you think they are.

---

## Day two: running it

### Updating

```sh
cd /opt/portionium && git pull
```

`git pull` only matters when `docker-compose.yml` or the `Caddyfile` changed. Then point at the
new release and restart:

```sh
sed -i 's/^PORTIONIUM_TAG=.*/PORTIONIUM_TAG=v0.2.0/' .env && docker compose pull && docker compose up -d
```

```sh
curl -s https://food.example.com/ready
```

Migrations run before the app starts listening, so restarting is the whole deployment. Expect a
few seconds of downtime: one container, one SQLite file, and a second copy writing to it would be
worse than a pause.

**Take a backup first** when the release changes the database in a way that removes something:

```sh
docker compose exec app node dist/cli/backup.js create
```

### Rolling back

When the release only added to the database, which is most of them, the image is the whole
rollback:

```sh
sed -i 's/^PORTIONIUM_TAG=.*/PORTIONIUM_TAG=v0.1.0/' .env && docker compose up -d
```

When it removed something, the old build refuses to start against the newer database, which is
`/ready` doing its job rather than a bug. There are no down migrations by decision, so the path
is restore, then downgrade, in that order. It is written out under "Rolling back a bad migration"
in [backup.md](./backup.md).

### Getting backups off the machine

`/data/backups` survives the container, the image and a bad update. It does not survive the
server. The archives are plain gzipped files with timestamps in their names, so anything that
copies files will do and there is deliberately no code for this in the app:

```sh
docker volume inspect portionium_data --format '{{ .Mountpoint }}'
```

```sh
sudo rclone copy /var/lib/docker/volumes/portionium_data/_data/backups remote:portionium-backups --max-age 48h
```

`remote:` is any of the providers rclone speaks. Object storage with a free tier is the obvious
choice, and if your domain is already at Cloudflare then R2 is one fewer account to make. Put
that line in a cron at 04:00, and have the cron ping a free [healthchecks.io](https://healthchecks.io)
check when it succeeds, so a copy that quietly stops becomes an email instead of a discovery
during an incident.

**Restore one of those copies occasionally.** A backup nobody has restored is a hope.

### Monitoring

One free uptime monitor on `https://food.example.com/health`, every five minutes, notifying by
email. UptimeRobot and Better Stack both do this at no cost.

Use `/health` and not `/ready`. It is a liveness check, it never touches the database, and it is
never rate limited, which is exactly what makes it the right target. A monitor on `/ready` would
alert during an update, and one on any other path would eventually be throttled and read as an
outage.

---

## When something is wrong

| Symptom                                       | Usually                                                                                                                       |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| https never gets a certificate                | DNS not pointing here yet, port 80 closed, or a CDN proxy is on. `docker compose logs caddy`                                  |
| `docker compose pull` asks for a password     | The package is still private. Make it public, or `docker login ghcr.io` with `read:packages`                                  |
| `/ready` is not 200                           | The image and the database disagree about the schema. The app log names the version it wanted                                 |
| Every write is refused                        | `WEB_ORIGIN` does not match the address in the browser, scheme included                                                       |
| `Permission denied (publickey)`               | Your client is offering a different key than the one in step 2a. `ssh -i` the right one, and compare `ssh-keygen -lf` on both |
| No key you own works                          | The provider's console gets you in without SSH. Fix `authorized_keys` there, or rebuild the machine, it holds nothing yet     |
| `docker compose` starts the app but not Caddy | `COMPOSE_PROFILES=caddy` missing from `.env`                                                                                  |

Every provider has a console that attaches to the machine directly rather than over SSH. That is
the way back in from a wrong key, a firewall rule that closed port 22, or an `sshd` that will not
start. Everything else here is recoverable by rebuilding the machine and restoring an archive,
which is the drill this whole page is arranged around.

## Why it looks like this

There is no Terraform, Pulumi or Ansible here, and no deploy from CI. A server, a firewall, a key
and a DNS record created once do not earn a state file, and a pipeline that can reach into this
machine is a credential worth stealing in exchange for saving two commands that run once a month.

That reasoning, the hosting options that lost, and the concrete signal that would change any of
it are in [ADR 009](../adr/009-hosting-and-deployment.md).
