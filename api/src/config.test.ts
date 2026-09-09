import { describe, expect, it } from 'vitest';

import { parseConfig } from './config.js';

describe('parseConfig', () => {
  it('applies defaults when nothing is set', () => {
    expect(parseConfig({})).toEqual({
      NODE_ENV: 'development',
      PORT: 3000,
      LOG_LEVEL: 'info',
      DATABASE_PATH: './data/portionium.db',
      WEB_ORIGIN: 'http://localhost:5173',
      SESSION_TTL_DAYS: 30,
      API_DOCS_ENABLED: true,
      IDEMPOTENCY_RETENTION_HOURS: 24,
    });
  });

  it('coerces PORT to a number', () => {
    expect(parseConfig({ PORT: '8080' }).PORT).toBe(8080);
  });

  it('rejects a PORT that is not a valid port number', () => {
    expect(() => parseConfig({ PORT: '70000' })).toThrow(/PORT/);
    expect(() => parseConfig({ PORT: 'nope' })).toThrow(/PORT/);
  });

  it('rejects an unknown NODE_ENV', () => {
    expect(() => parseConfig({ NODE_ENV: 'staging' })).toThrow(/NODE_ENV/);
  });

  it('reports every problem at once, not just the first', () => {
    const message = (() => {
      try {
        parseConfig({ NODE_ENV: 'staging', LOG_LEVEL: 'chatty' });
        return '';
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    })();

    expect(message).toContain('NODE_ENV');
    expect(message).toContain('LOG_LEVEL');
    expect(message).toContain('.env.example');
  });
});
