import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../common/current-user.decorator.js';
import { JwtAuthGuard } from '../common/jwt-auth.guard.js';
import { Roles } from '../common/roles.decorator.js';
import { RolesGuard } from '../common/roles.guard.js';
import { type Principal, Role } from '../common/principal.js';
import { ScheduleRoomDto } from './dto/schedule-room.dto.js';
import { RoomsService } from './rooms.service.js';

@Controller('rooms')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.STAFF)
export class RoomsController {
  constructor(private readonly rooms: RoomsService) {}
  @Post()
  schedule(@CurrentUser() principal: Principal, @Body() body: ScheduleRoomDto) { return this.rooms.schedule(body, principal.userId); }
}
