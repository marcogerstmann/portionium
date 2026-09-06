import { describe, expect, it } from 'vitest';

import { idSchema } from './index.js';

describe('idSchema', () => {
  it('accepts a UUIDv7', () => {
    expect(idSchema.safeParse('0199e0e9-1c4b-7000-8f2c-6e4c1c2a9b31').success).toBe(true);
  });

  it('rejects a UUIDv4, the version nibble is part of the contract', () => {
    expect(idSchema.safeParse('0199e0e9-1c4b-4000-8f2c-6e4c1c2a9b31').success).toBe(false);
  });

  it('rejects anything that is not a UUID', () => {
    expect(idSchema.safeParse('nope').success).toBe(false);
  });
});
