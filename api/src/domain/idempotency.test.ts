import { describe, expect, it } from 'vitest';

import { canonicalize, fingerprintRequest } from './idempotency.js';

describe('canonicalize', () => {
  it('writes object keys in sorted order at every depth', () => {
    expect(canonicalize({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it('keeps array order, because order is part of what an array means', () => {
    expect(canonicalize({ items: [{ z: 1 }, { y: 2 }] })).toBe('{"items":[{"z":1},{"y":2}]}');
  });
});

describe('fingerprintRequest', () => {
  const body = { name: 'Deploy', scopes: ['read'] };

  it('is the same for the same request whatever order the client wrote its keys in', () => {
    expect(fingerprintRequest('POST', '/x', { scopes: ['read'], name: 'Deploy' })).toBe(
      fingerprintRequest('POST', '/x', body),
    );
  });

  it.each([
    ['the method', fingerprintRequest('PUT', '/x', body)],
    ['the path', fingerprintRequest('POST', '/y', body)],
    ['the query string', fingerprintRequest('POST', '/x?a=1', body)],
    ['the body', fingerprintRequest('POST', '/x', { ...body, name: 'Other' })],
  ])('changes with %s', (_what, other) => {
    expect(other).not.toBe(fingerprintRequest('POST', '/x', body));
  });

  it('treats a request with no body as one with a null body', () => {
    expect(fingerprintRequest('DELETE', '/x', undefined)).toBe(
      fingerprintRequest('DELETE', '/x', null),
    );
  });
});
