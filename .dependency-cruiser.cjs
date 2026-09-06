/**
 * Source of truth for the layering rules inside api/src.
 * Run with `pnpm depcruise`. CI fails the build on any violation.
 *
 *   domain/  pure logic, imports nothing from db, http, mcp, and no framework
 *            or database library
 *   db/      may import domain, the only place Drizzle appears
 *   http/    may import domain and db, no business logic
 *   mcp/     may import domain and db, no business logic
 *   http/ and mcp/ never import each other
 */

/**
 * Packages matched by resolved path, not by module name. dependency-cruiser reports the
 * file it resolved to, which under pnpm looks like
 * node_modules/.pnpm/zod@4.5.4/node_modules/zod/index.d.cts. Anchoring on the package name
 * alone silently matches nothing, so every package rule keys off the node_modules/ segment.
 */
const PKG = (...names) => `node_modules/(${names.join('|')})/`;

/** Never allowed inside domain/. */
const INFRASTRUCTURE = PKG(
  'fastify',
  '@fastify',
  'drizzle-orm',
  'drizzle-kit',
  'better-sqlite3',
  'libsql',
  '@libsql',
);

/** Never allowed outside db/. */
const PERSISTENCE = PKG('drizzle-orm', 'drizzle-kit', 'better-sqlite3', 'libsql', '@libsql');

module.exports = {
  forbidden: [
    {
      name: 'domain-is-pure',
      comment:
        'domain/ holds entities and pure logic. It must not reach into persistence or transport. ' +
        'If domain needs something from db/, the dependency is pointing the wrong way, pass the ' +
        'data in or define a port in domain and implement it in db/.',
      severity: 'error',
      from: { path: '^api/src/domain/' },
      to: { path: '^api/src/(db|http|mcp)/' },
    },
    {
      name: 'domain-has-no-frameworks',
      comment:
        'domain/ must stay testable without a server or a database. No Fastify, no Drizzle, no driver.',
      severity: 'error',
      from: { path: '^api/src/domain/' },
      to: { path: INFRASTRUCTURE },
    },
    {
      name: 'db-does-not-import-adapters',
      comment: 'db/ sits below the adapters. It may import domain/ and nothing else from api/src.',
      severity: 'error',
      from: { path: '^api/src/db/' },
      to: { path: '^api/src/(http|mcp)/' },
    },
    {
      name: 'http-and-mcp-do-not-meet',
      comment:
        'http/ and mcp/ are sibling adapters over the same domain services. Sharing between them ' +
        'means the shared thing belongs in domain/.',
      severity: 'error',
      from: { path: '^api/src/(http|mcp)/' },
      to: { path: '^api/src/(http|mcp)/', pathNot: '^api/src/$1/' },
    },
    {
      name: 'drizzle-lives-only-in-db',
      comment:
        'Query building stays in db/. An adapter that writes its own query is business logic in the ' +
        'wrong layer, and it will not be covered by the repository userId rule.',
      severity: 'error',
      from: { path: '^api/src/', pathNot: '^api/src/db/' },
      to: { path: PERSISTENCE },
    },
    {
      name: 'no-circular',
      comment: 'A cycle means the module boundary is in the wrong place.',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'no-unresolvable',
      comment:
        'An import that does not resolve. Under NodeNext this is usually a missing .js extension on ' +
        'a relative import.',
      severity: 'error',
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: 'src-does-not-import-tests',
      comment: 'Production code must not depend on test helpers.',
      severity: 'error',
      from: { path: '^api/src/', pathNot: '\\.test\\.ts$' },
      to: { path: '(\\.test\\.ts$|^api/test/)' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'node', 'default', 'types'],
      extensions: ['.ts', '.js', '.json'],
    },
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
};
