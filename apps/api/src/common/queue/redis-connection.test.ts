import { describe, expect, it } from 'vitest';
import { buildBullConnection, parseRedisOptions } from './redis-connection.js';

describe('parseRedisOptions', () => {
  it('parses redis://host:port/db with defaults', () => {
    const opts = parseRedisOptions('redis://localhost:6379/0');
    expect(opts.host).toBe('localhost');
    expect(opts.port).toBe(6379);
    expect(opts.db).toBe(0);
    expect(opts.username).toBeUndefined();
    expect(opts.password).toBeUndefined();
    expect(opts.tls).toBeUndefined();
  });

  it('defaults port to 6379 and db to 0 when omitted', () => {
    const opts = parseRedisOptions('redis://localhost');
    expect(opts.port).toBe(6379);
    expect(opts.db).toBe(0);
  });

  it('extracts username + password (URL-decoded)', () => {
    const opts = parseRedisOptions('redis://alice:s%40cret%21@redis.example.com:6380/3');
    expect(opts.username).toBe('alice');
    expect(opts.password).toBe('s@cret!');
    expect(opts.host).toBe('redis.example.com');
    expect(opts.port).toBe(6380);
    expect(opts.db).toBe(3);
  });

  it('enables tls for rediss:// scheme', () => {
    const opts = parseRedisOptions('rediss://secure.example.com:6380');
    expect(opts.tls).toEqual({});
  });

  it('always sets BullMQ-required connection flags', () => {
    const opts = parseRedisOptions('redis://localhost:6379');
    expect(opts.maxRetriesPerRequest).toBeNull();
    expect(opts.enableReadyCheck).toBe(false);
    expect(opts.lazyConnect).toBe(true);
  });

  it('throws on non-redis protocols', () => {
    expect(() => parseRedisOptions('http://localhost:6379')).toThrow(/Invalid REDIS_URL protocol/);
  });

  it('throws on unparseable db index', () => {
    expect(() => parseRedisOptions('redis://localhost:6379/notanumber')).toThrow(
      /Invalid REDIS_URL db index/,
    );
  });
});

describe('buildBullConnection', () => {
  it('returns the same shape as parseRedisOptions for BullMQ ConnectionOptions', () => {
    const conn = buildBullConnection('redis://localhost:6379/1');
    expect(conn).toMatchObject({
      host: 'localhost',
      port: 6379,
      db: 1,
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    });
  });
});
