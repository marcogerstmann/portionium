# Security

This is a self hosted food and weight journal. The data in it is a household's eating and
weight, which is health data, and the whole of it is one SQLite file on somebody's machine.
That shapes everything below: there is no vendor to escalate to, the person running the
instance is the person who has to act, and a procedure that is not written down is one that
gets invented at the wrong moment.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting, on the **Security** tab of this repository,
**Report a vulnerability**. It opens a thread only you and the maintainer can read, which is
what a public issue is not.

Please include what you did, what happened, and what you expected. A path to reproduce it is
worth more than a severity rating. If it needs a running instance, say so and it will be run
against a scratch one rather than asked for a recording.

What to expect: an acknowledgement within a week, and a fix or a written reason it is not one.
There is no bounty and no service level agreement. This is a two person application maintained
by one person in evenings, and saying so is more useful than a promise that would not hold.

Please do not open a public issue for anything that lets one account read another's data,
bypasses authentication, or would be exploitable against an instance somebody else is running,
until it is fixed.

## What the credentials are

Four things, and they are not interchangeable. Knowing which one is loose is what decides what
to do about it.

| Credential   | Where it lives                            | What holds it                            | Grants                                                       |
| ------------ | ----------------------------------------- | ---------------------------------------- | ------------------------------------------------------------ |
| A password   | in somebody's head                        | `user.password_hash`, Argon2id at 19 MiB | everything that account can do                               |
| A session    | an `HttpOnly` cookie in one browser       | `session.token_hash`, SHA-256            | everything that account can do, until it idles out           |
| An API token | wherever the script that uses it keeps it | `api_token.token_hash`, SHA-256          | the scopes it was minted with, never more than its owner has |
| `AI_API_KEY` | the environment or a mounted file         | nothing, it is never stored              | spending money at the model provider                         |

**There is no session secret, and there is nothing to rotate that corresponds to one.** This is
worth stating plainly because it is the first thing anybody looks for. A session token is 32
bytes from a CSPRNG, minted per session, stored as a SHA-256 of itself and never written to a
log or a response body. There is no signing key, no HMAC and no JWT, so there is no single value
whose disclosure would forge sessions and no default that could be left in place by accident.
Rotating "the session secret" here means invalidating sessions, which is the procedure below.

The one setting that can still weaken a session is `WEB_ORIGIN`, because the cookie's `Secure`
flag follows its scheme. Plain http against a public host in production is refused at startup
rather than served, see `api/src/config.ts`. Loopback and private addresses over http are
allowed, because a machine on a home network is what this is for.

## Rotation and revocation

Every command below is run from the machine the database file is on. Being there is the
authorisation, which is the same authorisation restoring a backup needs. In a container:

```sh
docker compose exec app node dist/cli/user.js <command>
```

From a checkout:

```sh
pnpm --filter @portionium/api user <command>
```

### Ending every session of one account

A password change ends every session opened with the old password, in the same transaction, so
there is no window in which the old password is changed and a session it authorised is still
live. This is the "rotate the session credentials" procedure.

```sh
user passwd --email you@example.com
```

The password is read from a prompt that does not echo, or from stdin when it is piped in. It is
never an argument, because an argument is in a shell history and in the process list of everyone
on the machine while it runs.

API tokens deliberately survive a password change. They were issued on purpose to a script that
is not at the keyboard, and revoking them as a side effect of hygiene breaks automation quietly.
Revoke them explicitly, below, when that is what you mean.

### Revoking API tokens

One at a time, by its owner: `GET /api/v1/auth/tokens` lists them without the tokens themselves
and `DELETE /api/v1/auth/tokens/:id` revokes one. That is the right shape for retiring a script,
and it is the path the web client will use once it has a settings screen.

All of them at once, when a credential is believed to be loose and you do not yet know which:

```sh
user revoke-tokens --email you@example.com
```

It reports how many were live. Revocation takes effect on the next request, because there is no
cache in front of the token lookup. The rows are kept rather than deleted: a revoked token's
name and `last_used_at` are the record of what it was doing, which is the first thing anybody
wants afterwards.

Run it for every account, not just the one you suspect, if you do not know which credential
leaked. The list of accounts is in the `user` table.

### Rotating `AI_API_KEY`

Mint the new key at the provider, put it in `.env.docker` or the file the deployment mounts,
restart (`docker compose up -d`), confirm the startup line says the key is set, then revoke the
old key at the provider. That order leaves no gap in which the instance has no working key and
no period in which the old one is still accepted.

The key is never written to the database and never to a log: the startup line that prints the
resolved configuration masks any value whose name contains `KEY`, `SECRET`, `TOKEN`, `PASSWORD`
or `CREDENTIAL`.

### If the database file leaks

A copy of `portionium.db` is a copy of everybody's meals and weights, which is the real damage
and cannot be undone by rotating anything. It is not a set of live credentials: passwords are
Argon2id at OWASP's current parameters, and sessions and API tokens are stored as SHA-256 of 256
bits of randomness, so there is nothing in there to brute force back into a working credential.

Still, for every account: `user passwd`, which ends every session, and `user revoke-tokens`.
Then work out how the file got out, because the answer is usually a backup somewhere readable.

### If a secret reaches a commit

Rotate it first. It is in the history from the commit that added it, and every clone of that
history has it, so a later commit removing the line changes nothing about who can read it.
Rewriting the history is the second step and sometimes not worth it; assuming the value is burnt
is always correct.

## Keeping secrets out of the repository

Three layers, and only the middle one is enforcement.

`.env.example` is the whole configuration surface, committed, and holds names and safe defaults
and never a value. Real values go in `.env`, which is git ignored, or in `.env.docker`, which is
also git ignored and is what the container reads.

`.githooks/pre-commit` runs [gitleaks](https://github.com/gitleaks/gitleaks) over the staged
diff and refuses the commit on a finding. `pnpm install` points `core.hooksPath` at that
directory, so there is no setup step and no hook manager in the dependency tree. It needs
gitleaks on the path (`brew install gitleaks`); without it the hook says so and stands aside,
because a hook that blocks every developer who has not installed a tool is a hook that gets
skipped with `--no-verify` forever after.

The `secrets` job in CI runs the same scan over the whole history, on every push and every pull
request, and that is the one that cannot be skipped. Findings are redacted in both, so a leak
does not become a second copy of itself in a log.

## Dependencies

`pnpm audit --audit-level high` runs in CI and fails the build on a high or critical advisory.
Moderates are reported and do not block, because a gate that fires weekly on a slow regular
expression in a build tool is a gate people stop reading.

Dependabot opens one grouped pull request a week for patches and minors, and a separate one per
major, see `.github/dependabot.yml`. Every version in this repository is an exact pin and the
lockfile is committed, so what a build resolves is what was reviewed.

## What is deliberately not here

No public sign up, so the only accounts are the ones an administrator made from a terminal. No
password reset by email, so there is no mail flow to take over. No secrets in the image: the
Dockerfile sets defaults that make a first run work and none of them is a credential. The
container runs as uid 1000 and its only writable path is the data volume.
