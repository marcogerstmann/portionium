import { z } from 'zod';

/**
 * Schemas shared by the API and the web app. This package is the single definition of a
 * request or response shape, so a contract change breaks the typecheck on both sides at once.
 * It depends on Zod and nothing else, see .dependency-cruiser.cjs.
 *
 * The entity schemas arrive with the domain model story. Only the id primitive lives here now.
 */

/** Every user owned row is keyed by a UUIDv7, so ids sort by creation time. */
export const idSchema = z.uuidv7();

export type Id = z.infer<typeof idSchema>;
