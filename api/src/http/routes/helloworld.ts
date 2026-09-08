import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

/**
 * DELETE THIS FILE once at least one real v1 endpoint exists.
 *
 * It is a placeholder with no product meaning. It is here so that the versioned surface is not
 * empty while the first real endpoint is being written: it keeps `/api/v1` in the generated
 * OpenAPI document, and it is the worked example to copy from. Its only reason to exist ends
 * the moment a real route takes over that job. Delete the file, its registration in
 * `http/app.ts`, and its tests in `api/test/http/app.test.ts`.
 *
 * What it demonstrates, and what a real versioned route is expected to do:
 *
 *   - it is registered inside the `API_PREFIX` block in app.ts, so its path is versioned
 *   - it declares a Zod schema for every part of the request it reads, and for every status
 *     it answers with
 *   - request schemas are strict, so a parameter nobody declared is a 400 and not a shrug
 *   - the handler declares no types of its own. Its argument and its return type are inferred
 *     from the schemas above it, which is also what the OpenAPI document is generated from
 */

const helloWorldQuerySchema = z.strictObject({
  /**
   * A default belongs in the schema rather than in the handler. It is then part of the
   * contract, and it shows up in the generated document, which is where a client looks to
   * find out what happens when it sends nothing.
   */
  name: z.string().min(1).max(100).default('world'),
});

const helloWorldResponseSchema = z.object({
  message: z.string(),
});

export const helloWorldRoutes: FastifyPluginCallbackZod = (app, _options, done) => {
  app.get(
    '/helloworld',
    {
      schema: {
        summary: 'Placeholder, delete with the first real v1 endpoint',
        querystring: helloWorldQuerySchema,
        response: { 200: helloWorldResponseSchema },
      },
    },
    // `request.query.name` is a string here, never undefined, because the schema said so.
    (request) => ({ message: `Hello, ${request.query.name}` }),
  );

  done();
};
