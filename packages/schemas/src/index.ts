/**
 * Schemas shared by the API and the web app. This package is the single definition of a
 * request or response shape, so a contract change breaks the typecheck on both sides at once.
 * It depends on Zod and nothing else, see .dependency-cruiser.cjs.
 *
 *   primitives.ts  ids, dates, timestamps and the closed unions
 *   entities.ts    the persisted shape of each entity
 *   api.ts         what crosses the wire, and the grams to kilograms conversion
 *   problem.ts     the RFC 9457 shape every error response takes
 *
 * Shape and context free validation only. Invariants that need to look at anything beyond the
 * object in front of them live in api/src/domain/, which is server side and can load history.
 */
export * from './primitives.js';
export * from './entities.js';
export * from './api.js';
export * from './problem.js';
