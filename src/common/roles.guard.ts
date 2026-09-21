import { CanActivate, type ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from './roles.decorator.js';
import type { Role } from './principal.js';
import type { RequestWithPrincipal } from './jwt-auth.guard.js';
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}
  canActivate(context: ExecutionContext): boolean {
    const roles = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [context.getHandler(), context.getClass()]);
    if (!roles) return true;
    if (!roles.includes(context.switchToHttp().getRequest<RequestWithPrincipal>().principal!.role)) throw new ForbiddenException('Tu rol no permite esta operacion.');
    return true;
  }
}
