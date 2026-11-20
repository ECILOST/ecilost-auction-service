import { type ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuctionConfig } from '../config/auction.config.js';
import { JwtAuthGuard, type RequestWithPrincipal } from './jwt-auth.guard.js';

const config: AuctionConfig = {
  authJwksUrl: 'https://auth.example.test/.well-known/jwks.json',
  jwtIssuer: 'https://auth.example.test',
  jwtAudience: 'ecilost-test',
  databaseUrl: 'postgresql://localhost/auction_fixture',
  databaseSchema: 'auction',
  rabbitmqUrl: 'amqp://localhost',
};

function requestContext(token: string) {
  const request = { headers: { authorization: `Bearer ${token}` } } as RequestWithPrincipal;
  const context = { switchToHttp: () => ({ getRequest: () => request }) } as ExecutionContext;
  return { context, request };
}

describe('JwtAuthGuard', () => {
  let keys: Awaited<ReturnType<typeof generateKeyPair>>;
  let guard: JwtAuthGuard;

  beforeAll(async () => {
    keys = await generateKeyPair('RS256');
  });

  beforeEach(async () => {
    const jwk = { ...(await exportJWK(keys.publicKey)), alg: 'RS256', kid: 'test' };
    vi.stubGlobal('fetch', async () => Response.json({ keys: [jwk] }));
    guard = new JwtAuthGuard(config);
  });

  afterEach(() => vi.unstubAllGlobals());

  function token(expiresIn?: string) {
    const jwt = new SignJWT({ role: 'STUDENT' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test' })
      .setSubject('student-fixture')
      .setIssuer(config.jwtIssuer)
      .setAudience(config.jwtAudience)
      .setIssuedAt();
    if (expiresIn) jwt.setExpirationTime(expiresIn);
    return jwt.sign(keys.privateKey);
  }

  it('acepta un JWT vigente y adjunta el principal', async () => {
    const { context, request } = requestContext(await token('1m'));

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.principal).toMatchObject({ userId: 'student-fixture', role: 'STUDENT' });
  });

  it.each([
    { status: 'sin vencimiento', expiresIn: undefined },
    { status: 'vencido', expiresIn: '-1m' },
  ])('rechaza un JWT $status con 401', async ({ expiresIn }) => {
    const { context, request } = requestContext(await token(expiresIn));

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(request.principal).toBeUndefined();
  });
});
