import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuctionConfig, validateEnv } from './auction.config.js';

const environment = {
  DATABASE_URL: 'postgresql://test:test@localhost/auction',
  AUTH_JWKS_URL: 'http://localhost:3000/auth/jwks',
  JWT_ISSUER: 'test-auth',
  JWT_AUDIENCE: 'test-api',
  RABBITMQ_URL: 'amqp://localhost',
};

describe('AuctionConfig', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('reports the fields that are required or malformed', () => {
    expect(() => validateEnv({ ...environment, JWT_ISSUER: '', AUTH_JWKS_URL: 'invalid url' }))
      .toThrow(/AUTH_JWKS_URL.*JWT_ISSUER/);
  });

  it.each([
    [environment.DATABASE_URL, 'auction'],
    [environment.DATABASE_URL + '?schema=auction_integration', 'auction_integration'],
  ])('maps environment settings and resolves the database schema', (databaseUrl, schema) => {
    for (const [name, value] of Object.entries({ ...environment, DATABASE_URL: databaseUrl })) {
      vi.stubEnv(name, value);
    }
    expect(new AuctionConfig()).toMatchObject({
      databaseUrl, databaseSchema: schema,
      authJwksUrl: environment.AUTH_JWKS_URL,
      jwtIssuer: environment.JWT_ISSUER,
      jwtAudience: environment.JWT_AUDIENCE,
      rabbitmqUrl: environment.RABBITMQ_URL,
    });
  });
});
