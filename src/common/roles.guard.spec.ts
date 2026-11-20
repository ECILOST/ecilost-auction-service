import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import { Principal, Role } from './principal.js';
import { ROLES_KEY } from './roles.decorator.js';
import { RolesGuard } from './roles.guard.js';

function request(role: Role, allowedRoles?: Role[]): ExecutionContext {
  const handler = () => undefined;
  class Controller {}
  if (allowedRoles) Reflect.defineMetadata(ROLES_KEY, allowedRoles, handler);
  return {
    getHandler: () => handler,
    getClass: () => Controller,
    switchToHttp: () => ({ getRequest: () => ({ principal: new Principal('user-1', role) }) }),
  } as unknown as ExecutionContext;
}

describe('RolesGuard', () => {
  const guard = new RolesGuard(new Reflector());

  it('allows a route without role requirements', () => {
    expect(guard.canActivate(request(Role.STUDENT))).toBe(true);
  });

  it('allows only the declared role on a protected route', () => {
    expect(guard.canActivate(request(Role.STAFF, [Role.STAFF]))).toBe(true);
    expect(() => guard.canActivate(request(Role.STUDENT, [Role.STAFF]))).toThrow(ForbiddenException);
  });
});
