import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { RequestWithPrincipal } from './jwt-auth.guard.js';
export const CurrentUser = createParamDecorator((_d: unknown, c: ExecutionContext) => c.switchToHttp().getRequest<RequestWithPrincipal>().principal);
