import { describe, expect, it } from 'vitest';

import { type Config, maskedConfig, parseConfig } from './config.js';

describe('parseConfig', () => {
  it('applies defaults when nothing is set', () => {
    expect(parseConfig({})).toEqual({
      NODE_ENV: 'development',
      PORT: 3000,
      LOG_LEVEL: 'info',
      DATABASE_PATH: './data/portionium.db',
      WEB_ORIGIN: 'http://localhost:5173',
      WEB_ROOT: '',
      SESSION_TTL_DAYS: 30,
      API_DOCS_ENABLED: true,
      IDEMPOTENCY_RETENTION_HOURS: 24,
      RATE_LIMIT_READ_PER_MINUTE: 120,
      RATE_LIMIT_WRITE_PER_MINUTE: 30,
      RATE_LIMIT_AUTH_PER_MINUTE: 20,
      MAX_BODY_BYTES: 1_048_576,
      CORS_ORIGINS: [],
      WEIGHT_MAX_DRIFT_PER_DAY: 0.02,
      WEIGHT_TREND_HALF_LIFE_DAYS: 10,
      BACKUP_DIR: '',
      BACKUP_INTERVAL_HOURS: 24,
      BACKUP_KEEP_DAILY: 7,
      BACKUP_KEEP_WEEKLY: 4,
      BACKUP_KEEP_MONTHLY: 3,
      AI_API_KEY: '',
    });
  });

  it('reads CORS_ORIGINS as a list and normalises each entry', () => {
    expect(
      parseConfig({ CORS_ORIGINS: 'https://a.example, https://b.example:443/' }).CORS_ORIGINS,
    ).toEqual(['https://a.example', 'https://b.example']);
  });

  it('rejects a CORS origin that is not a URL, a wildcard included', () => {
    expect(() => parseConfig({ CORS_ORIGINS: '*' })).toThrow(/CORS_ORIGINS/);
    expect(() => parseConfig({ CORS_ORIGINS: 'https://ok.example,nonsense' })).toThrow(
      /CORS_ORIGINS/,
    );
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

  it('takes the AI key when it is given and defaults it to absent, because it is optional', () => {
    expect(parseConfig({ AI_API_KEY: 'sk-test' }).AI_API_KEY).toBe('sk-test');
    expect(parseConfig({}).AI_API_KEY).toBe('');
  });

  it('refuses to start on plain http against a public host in production', () => {
    expect(() =>
      parseConfig({ NODE_ENV: 'production', WEB_ORIGIN: 'http://food.example.com' }),
    ).toThrow(/WEB_ORIGIN/);
  });

  it('allows plain http on a local address in production, which is how the image ships', () => {
    for (const origin of [
      'http://localhost:8080',
      'http://127.0.0.1:8080',
      'http://[::1]:8080',
      'http://192.168.1.5:8080',
      'http://10.0.0.4:8080',
      'http://172.16.0.4:8080',
      'http://raspberrypi:8080',
      'http://pi.local:8080',
    ]) {
      expect(parseConfig({ NODE_ENV: 'production', WEB_ORIGIN: origin }).WEB_ORIGIN).toBe(origin);
    }
  });

  it('allows the same public origin over https, and outside production either way', () => {
    expect(
      parseConfig({ NODE_ENV: 'production', WEB_ORIGIN: 'https://food.example.com' }).WEB_ORIGIN,
    ).toBe('https://food.example.com');
    expect(
      parseConfig({ NODE_ENV: 'development', WEB_ORIGIN: 'http://food.example.com' }).WEB_ORIGIN,
    ).toBe('http://food.example.com');
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

describe('maskedConfig', () => {
  it('passes everything that is not a secret through untouched', () => {
    const config = parseConfig({});

    expect(maskedConfig(config)).toEqual({ ...config, AI_API_KEY: '[redacted]' });
  });

  it('keeps the AI key out of the startup line it is written for', () => {
    const config = parseConfig({ AI_API_KEY: 'sk-ant-real' });

    expect(maskedConfig(config).AI_API_KEY).toBe('[redacted]');
    expect(JSON.stringify(maskedConfig(config))).not.toContain('sk-ant-real');
  });

  it('masks a value whose key names a secret, so the next one added is covered by its name', () => {
    // Cast because no such variable exists yet. That is the point of matching on the name: the
    // day a second credential arrives it is masked without anybody remembering to come here.
    const config = { ...parseConfig({}), SMTP_PASSWORD: 'hunter2' } as unknown as Config;

    expect(maskedConfig(config).SMTP_PASSWORD).toBe('[redacted]');
    expect(JSON.stringify(maskedConfig(config))).not.toContain('hunter2');
  });
});
