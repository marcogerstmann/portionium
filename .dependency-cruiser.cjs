/**
 * Under pnpm a package resolves to node_modules/.pnpm/<name>@<version>/..., so rules key off the
 * node_modules/ segment rather than the package name.
 */
const PKG = (...names) => `node_modules/(${names.join('|')})/`;

const INFRASTRUCTURE = PKG(
  'fastify',
  '@fastify',
  'drizzle-orm',
  'drizzle-kit',
  'better-sqlite3',
  'libsql',
  '@libsql',
);

const PERSISTENCE = PKG('drizzle-orm', 'drizzle-kit', 'better-sqlite3', 'libsql', '@libsql');

/**
 * pnpm symlinks workspace packages, so an import of @portionium/schemas is reported as
 * packages/schemas/src/...
 */
const SCHEMAS = '^packages/schemas/';

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
      name: 'cli-does-not-import-adapters',
      comment:
        'cli/ is a third adapter over the same domain and the same repositories. A command that ' +
        'reaches into a route is a command that will one day need a request object to run, and ' +
        'whatever it wanted from there belongs in domain/ or db/.',
      severity: 'error',
      from: { path: '^api/src/cli/' },
      to: { path: '^api/src/(http|mcp)/' },
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
      name: 'schemas-import-only-zod',
      comment:
        'packages/schemas is shared by the API and the web app, so it must stay loadable in both. ' +
        'Anything beyond Zod drags a runtime into one of them. If a schema needs a helper, inline it. ' +
        'Tests are exempt, they never ship.',
      severity: 'error',
      from: { path: SCHEMAS, pathNot: '\\.test\\.tsx?$' },
      to: { path: 'node_modules/', pathNot: PKG('zod') },
    },
    {
      name: 'schemas-import-nothing-from-the-apps',
      comment:
        'The shared package sits below both apps. An import pointing back up is a cycle waiting ' +
        'to happen, and it would break whichever app does not have that file.',
      severity: 'error',
      from: { path: SCHEMAS },
      to: { path: '^(api|web)/' },
    },
    {
      name: 'web-does-not-import-api',
      comment:
        'The web app talks to the API over HTTP, never by importing its source. Everything the ' +
        'two share is a schema, and a schema belongs in @portionium/schemas.',
      severity: 'error',
      from: { path: '^web/' },
      to: { path: '^api/' },
    },
    {
      name: 'api-does-not-import-web',
      comment: 'The API knows nothing about the client. The dependency only ever points one way.',
      severity: 'error',
      from: { path: '^api/' },
      to: { path: '^web/' },
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
      from: { path: '^(api/src|packages/schemas/src|web/src)/', pathNot: '\\.test\\.tsx?$' },
      to: { path: '(\\.test\\.tsx?$|^api/test/)' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'node', 'default', 'types'],
      extensions: ['.ts', '.tsx', '.js', '.jsx', '.json'],
    },
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
};
