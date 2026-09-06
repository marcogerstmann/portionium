/**
 * Every table in the database, re-exported as one object so `drizzle(client, { schema })`
 * and the repositories share a single import point.
 *
 * The entity tables arrive with the domain model story. Only the shared column helper
 * lives here now.
 */
export * from './base.js';
