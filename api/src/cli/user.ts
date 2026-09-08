import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';

import { z } from 'zod';

import {
  dayBoundaryHourSchema,
  emailSchema,
  passwordSchema,
  timezoneSchema,
  userRoleSchema,
  userSchema,
} from '@portionium/schemas';

import { parseConfig } from '../config.js';
import { countUsers, findUserByEmail, insertUser, setPasswordHash } from '../db/auth.js';
import { openDatabase } from '../db/client.js';
import { hashPassword } from '../domain/auth.js';

/**
 * Account administration, from a terminal on the machine the database is on.
 *
 * This exists because the API has no way to make the first account: every endpoint that could
 * create one would have to be reachable without credentials, and an endpoint like that on a
 * public instance is not a bootstrap, it is the vulnerability. Being on the box with the file
 * is the authorisation here, which is the same authorisation restoring a backup needs.
 *
 * It is also, for now, the only way to make any account or reset any password. Doing those over
 * HTTP needs a request that has already been authenticated as an administrator, and the plugin
 * that establishes who a request is from is the next story. The functions it would call are in
 * db/auth.ts already, so that endpoint is a route file and not a rewrite.
 *
 *   pnpm --filter @portionium/api user create --email a@b.de --name "Ada" --timezone Europe/Berlin
 *   pnpm --filter @portionium/api user passwd --email a@b.de
 *
 * The password is never an argument. Anything on a command line is in the shell history of
 * whoever typed it and in the process list of everybody on the machine while it runs, so it is
 * typed at a prompt that does not echo, or piped in for a script that has it already.
 */

const USAGE = `Usage:
  user create --email <address> --name <display name> --timezone <IANA zone>
              [--role user|admin] [--day-boundary-hour 0-23]
  user passwd --email <address>

The password is read from a prompt, or from stdin when it is piped in.
The first account on a fresh instance is an admin unless --role says otherwise.`;

/**
 * Reads a password without putting it on the screen.
 *
 * Piped input is taken whole, minus the newline the pipe added, so a script can hand one over
 * without a terminal. At a terminal, readline's echo is switched off and the answer is asked
 * for twice, because a mistyped password nobody can see is a locked out account.
 */
async function readPassword(): Promise<string> {
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk as Buffer);
    }

    return Buffer.concat(chunks)
      .toString('utf8')
      .replace(/\r?\n$/, '');
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });

  // readline echoes every keystroke it reads. Silencing that method is how a password prompt is
  // written against this module, and it is why the prompt itself is written to stdout directly.
  (rl as unknown as { _writeToOutput: () => void })._writeToOutput = () => {};

  try {
    process.stdout.write('Password: ');
    const password = await rl.question('');
    process.stdout.write('\nRepeat: ');
    const again = await rl.question('');
    process.stdout.write('\n');

    if (password !== again) {
      throw new Error('The two passwords do not match.');
    }

    return password;
  } finally {
    rl.close();
  }
}

/** Missing rather than empty, so `--email` with nothing after it is an error and not an address. */
function required(value: string | undefined, flag: string): string {
  if (value === undefined || value.trim() === '') {
    throw new Error(`${flag} is required.\n\n${USAGE}`);
  }

  return value;
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    email: { type: 'string' },
    name: { type: 'string' },
    timezone: { type: 'string' },
    role: { type: 'string' },
    'day-boundary-hour': { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});

try {
  const command = positionals[0];

  if (values.help === true || command === undefined) {
    console.log(USAGE);
    process.exit(values.help === true ? 0 : 1);
  }

  const config = parseConfig(process.env);
  // Same call the server makes, so a CLI run against a fresh instance migrates it first and
  // there is no order in which the two have to be started.
  const database = openDatabase(config.DATABASE_PATH);

  try {
    const email = emailSchema.parse(required(values.email, '--email'));

    if (command === 'create') {
      if (findUserByEmail(database.db, email) !== undefined) {
        throw new Error(`An account already exists for ${email}.`);
      }

      const displayName = userSchema.shape.displayName.parse(required(values.name, '--name'));
      const timezone = timezoneSchema.parse(required(values.timezone, '--timezone'));
      const dayBoundaryHour =
        values['day-boundary-hour'] === undefined
          ? undefined
          : dayBoundaryHourSchema.parse(Number(values['day-boundary-hour']));

      // The chicken and egg, resolved by the only fact that distinguishes a fresh instance:
      // there is nobody to have granted the role, so the first account grants it to itself.
      // Every account after it is a plain user unless somebody says otherwise.
      const isFirstAccount = countUsers(database.db) === 0;
      const role = userRoleSchema.parse(values.role ?? (isFirstAccount ? 'admin' : 'user'));

      const passwordHash = await hashPassword(passwordSchema.parse(await readPassword()));

      const user = insertUser(database.db, {
        email,
        passwordHash,
        displayName,
        role,
        timezone,
        ...(dayBoundaryHour === undefined ? {} : { dayBoundaryHour }),
      });

      console.log(`Created ${user.role} ${user.email} (${user.id}).`);
    } else if (command === 'passwd') {
      const user = findUserByEmail(database.db, email);
      if (user === undefined) {
        throw new Error(`No account for ${email}.`);
      }

      const passwordHash = await hashPassword(passwordSchema.parse(await readPassword()));
      const invalidated = setPasswordHash(database.db, user.id, passwordHash);

      console.log(
        `Password changed for ${user.email}. ${invalidated} session(s) invalidated, API tokens untouched.`,
      );
    } else {
      throw new Error(`Unknown command "${command}".\n\n${USAGE}`);
    }
  } finally {
    database.close();
  }
} catch (error) {
  // A Zod issue printed as a Zod issue is a JSON dump at somebody who typed a short password.
  // Only the messages are useful here, and the paths are empty anyway: each value above is
  // parsed on its own rather than as a field of a larger object.
  console.error(
    error instanceof z.ZodError
      ? error.issues.map((issue) => issue.message).join('\n')
      : error instanceof Error
        ? error.message
        : String(error),
  );
  process.exit(1);
}
