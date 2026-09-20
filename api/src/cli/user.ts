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
import { readPassword } from './prompt.js';
import {
  countUsers,
  findUserByEmail,
  insertUser,
  revokeAllApiTokens,
  setPasswordHash,
} from '../db/auth.js';
import { openDatabase } from '../db/client.js';
import { hashPassword } from '../domain/auth.js';

const USAGE = `Usage:
  user create --email <address> --name <display name> --timezone <IANA zone>
              [--role user|admin] [--day-boundary-hour 0-23]
  user passwd --email <address>
  user revoke-tokens --email <address>

The password is read from a prompt, or from stdin when it is piped in.
The first account on a fresh instance is an admin unless --role says otherwise.
revoke-tokens kills every API token the account has, see SECURITY.md.`;

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

      const isFirstAccount = countUsers(database.db) === 0;
      const role = userRoleSchema.parse(values.role ?? (isFirstAccount ? 'admin' : 'user'));

      const passwordHash = await hashPassword(
        passwordSchema.parse(await readPassword({ input: process.stdin, output: process.stdout })),
      );

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

      const passwordHash = await hashPassword(
        passwordSchema.parse(await readPassword({ input: process.stdin, output: process.stdout })),
      );
      const invalidated = setPasswordHash(database.db, user.id, passwordHash);

      console.log(
        `Password changed for ${user.email}. ${invalidated} session(s) invalidated, API tokens untouched.`,
      );
    } else if (command === 'revoke-tokens') {
      const user = findUserByEmail(database.db, email);
      if (user === undefined) {
        throw new Error(`No account for ${email}.`);
      }

      const revoked = revokeAllApiTokens(database.db, user.id);

      console.log(
        `Revoked ${revoked} API token(s) for ${user.email}. Sessions untouched, run passwd to end those.`,
      );
    } else {
      throw new Error(`Unknown command "${command}".\n\n${USAGE}`);
    }
  } finally {
    database.close();
  }
} catch (error) {
  console.error(
    error instanceof z.ZodError
      ? error.issues.map((issue) => issue.message).join('\n')
      : error instanceof Error
        ? error.message
        : String(error),
  );
  process.exit(1);
}
