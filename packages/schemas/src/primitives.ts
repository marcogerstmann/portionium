import { z } from 'zod';

/**
 * The small pieces every entity is built from. Each union is defined once here and reused by
 * the entity schemas, by the API schemas, and by the Drizzle column definitions in
 * api/src/db/schema/, so a value can never drift between the wire and the column.
 */

/** Every user owned row is keyed by a UUIDv7, so ids sort by creation time. */
export const idSchema = z.uuidv7();

export type Id = z.infer<typeof idSchema>;

/**
 * A calendar date with no time and no zone, `YYYY-MM-DD`. Zod's ISO date format already knows
 * which months have 31 days and which years have a 29th of February, so there is no regex here.
 *
 * Deriving one of these from an instant plus a user timezone is the day boundary story, not
 * this package. Anything that stores a local date receives it, it never computes it.
 */
export const localDateSchema = z.iso.date();

export type LocalDate = z.infer<typeof localDateSchema>;

/**
 * An IANA timezone name. Validated against the runtime's own timezone database rather than
 * against a bundled list, which keeps this package on Zod alone and keeps the list current.
 * Both Node and the browser ship the same database, so a name accepted here is a name the
 * server can convert with later.
 */
export const timezoneSchema = z.string().refine(
  (value) => {
    try {
      Intl.DateTimeFormat(undefined, { timeZone: value });
      return true;
    } catch {
      return false;
    }
  },
  { message: 'Unknown IANA timezone' },
);

export type Timezone = z.infer<typeof timezoneSchema>;

/**
 * The local hour a user's day starts at, 0 to 23. Four means a meal logged at 01:00 counts
 * towards the day before, which is how people describe a late evening and not how a clock
 * describes it.
 *
 * Four rather than three or five because it clears the small hours without reaching breakfast,
 * see docs/adr/002-local-day-boundaries.md. It is a column with a default and not a constant,
 * because shift workers exist.
 */
export const dayBoundaryHourSchema = z.int().min(0).max(23);

export const DEFAULT_DAY_BOUNDARY_HOUR = 4;

/**
 * An instant. Accepts a Date, or the UTC ISO string a Date turns into once it has been through
 * JSON, and yields a Date either way. That is what lets one entity schema serve the server,
 * which holds Dates, and the browser, which receives strings.
 *
 * No offset is permitted. Timestamps are UTC, so anything carrying `+02:00` is a bug upstream.
 */
export const timestampSchema = z
  .union([z.date(), z.iso.datetime()])
  .transform((value) => new Date(value));

/**
 * An email address, normalised before it is validated. Trimmed and lowercased, so the spelling
 * that reaches the database is the spelling every later lookup derives from the same input.
 *
 * Lowercasing the local part is not what RFC 5321 says. That document leaves everything before
 * the @ to the receiving server and permits it to be case sensitive. No provider anybody uses
 * actually treats it that way, and an account that can be created a second time by capitalising
 * a letter is a worse problem than a rule nobody implements. This is also what makes the unique
 * constraint on the column case insensitive: there is only ever one spelling of an address here.
 */
export const emailSchema = z.string().trim().toLowerCase().pipe(z.email());

export type Email = z.infer<typeof emailSchema>;

/**
 * The longest password that will be hashed. Not a security property: it is what stops a
 * megabyte of input from being handed to a deliberately memory hard function on an endpoint
 * that anybody can reach without credentials.
 */
export const PASSWORD_MAX_LENGTH = 256;

/**
 * A password on its way to being stored, never one being checked.
 *
 * Length is the only rule. NIST SP 800-63B dropped composition requirements because they push
 * people towards Passw0rd! and away from four random words, and twelve characters sits above
 * the floor that same document sets.
 *
 * Deliberately not used by the login request, see loginRequestSchema in api.ts. Holding a
 * submitted password to this policy would answer 400 for a password that is merely wrong, and
 * that is a second response shape on the one endpoint whose whole job is to have exactly one.
 */
export const passwordSchema = z.string().min(12).max(PASSWORD_MAX_LENGTH);

/**
 * Each closed union is written as a readonly tuple first and the Zod enum derived from it.
 * The tuple is what Drizzle's `text(name, { enum })` needs, `.options` widens to an array and
 * would have to be cast at every column. Writing it this way means the union is declared once
 * and neither the schema nor the column definition needs a cast.
 *
 * The tuples are also the render order for anything that lists these values.
 */

/** The traffic light. The one thing the whole product is about, so it is defined exactly once. */
export const CATEGORIES = ['green', 'yellow', 'orange'] as const;

export const categorySchema = z.enum(CATEGORIES);

export type Category = z.infer<typeof categorySchema>;

/**
 * What a food is, descriptively. Nothing branches on this, it exists so a list can be grouped
 * and a search can be filtered. If behaviour ever hangs off one of these values, that is a
 * signal the value belongs somewhere else.
 */
export const FOOD_KINDS = ['ingredient', 'dish', 'branded'] as const;

export const foodKindSchema = z.enum(FOOD_KINDS);

export type FoodKind = z.infer<typeof foodKindSchema>;

/**
 * Where a classification came from. `ai_vision` is reserved for the photo flow and is not
 * produced by anything yet, it is here so adding that flow is not a migration.
 */
export const CLASSIFICATION_SOURCES = ['seed', 'ai_text', 'ai_vision', 'user'] as const;

export const classificationSourceSchema = z.enum(CLASSIFICATION_SOURCES);

export type ClassificationSource = z.infer<typeof classificationSourceSchema>;

export const USER_ROLES = ['user', 'admin'] as const;

export const userRoleSchema = z.enum(USER_ROLES);

export type UserRole = z.infer<typeof userRoleSchema>;

export const MEAL_TYPES = ['breakfast', 'lunch', 'dinner', 'snack'] as const;

export const mealTypeSchema = z.enum(MEAL_TYPES);

export type MealType = z.infer<typeof mealTypeSchema>;

/**
 * Body weight in whole grams. Integers, because a kilogram stored as a float accumulates drift
 * across the arithmetic a trend line does. Kilograms exist only on the wire, see api.ts.
 *
 * This is a shape check, not a plausibility check. Whether a number is a believable human
 * weight depends on the entries around it, which is a domain question, see
 * api/src/domain/weight.ts.
 */
export const weightGramsSchema = z.int().positive();
