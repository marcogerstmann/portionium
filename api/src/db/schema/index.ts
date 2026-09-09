/**
 * Every table in the database, re-exported as one object so `drizzle(client, { schema })`
 * and the repositories share a single import point.
 *
 * One file per table, and the closed unions come from @portionium/schemas rather than being
 * restated here, so a value the API accepts and a value the column allows cannot drift apart.
 */
export * from './base.js';
export * from './user.js';
export * from './session.js';
export * from './api-token.js';
export * from './idempotency-key.js';
export * from './food.js';
export * from './food-classification.js';
export * from './meal.js';
export * from './meal-item.js';
export * from './weight-entry.js';
