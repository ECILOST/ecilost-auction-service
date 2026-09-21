import { CanActivate, type ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { AuctionConfig } from '../config/auction.config.js';
import { Principal, type Role } from './principal.js';
export interface RequestWithPrincipal extends Request { principal?: Principal }
@Injectable()
export class JwtAuthGuard implements CanActivate {
  private readonly jwks;
  constructor(private readonly config: AuctionConfig) { this.jwks = createRemoteJWKSet(new URL(config.authJwksUrl)); }
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithPrincipal>();
    const token = request.headers.authorization?.split(' ')[1];
    if (!token) throw new UnauthorizedException('Falta el token de acceso.');
    try {
      const { payload } = await jwtVerify(token, this.jwks, { issuer: this.config.jwtIssuer, audience: this.config.jwtAudience, algorithms: ['RS256'] });
      if (!payload.sub || (payload.role !== 'STAFF' && payload.role !== 'STUDENT')) throw new Error('claims incompletos');
      request.principal = new Principal(payload.sub, payload.role as Role);
      return true;
    } catch { throw new UnauthorizedException('El token de acceso no es valido.'); }
  }
}
