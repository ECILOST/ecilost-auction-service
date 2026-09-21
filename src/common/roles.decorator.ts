import { SetMetadata } from '@nestjs/common';
import type { Role } from './principal.js';
export const ROLES_KEY = 'ecilost:roles';
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);
