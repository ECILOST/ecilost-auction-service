import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../common/current-user.decorator.js';
import { JwtAuthGuard } from '../common/jwt-auth.guard.js';
import { Roles } from '../common/roles.decorator.js';
import { RolesGuard } from '../common/roles.guard.js';
import { type Principal, Role } from '../common/principal.js';
import { SetDynamicModesDto } from './dto/dynamic-modes.dto.js';
import { ListRoomsQueryDto } from './dto/list-rooms-query.dto.js';
import { ScheduleRoomDto } from './dto/schedule-room.dto.js';
import { DynamicModesService } from './dynamic-modes.service.js';
import { RoomsService } from './rooms.service.js';

@Controller('rooms')
@UseGuards(JwtAuthGuard, RolesGuard)
export class RoomsController {
  constructor(private readonly rooms: RoomsService, private readonly dynamicModes: DynamicModesService) {}

  @Post()
  @Roles(Role.STAFF)
  schedule(@CurrentUser() principal: Principal, @Body() body: ScheduleRoomDto) { return this.rooms.schedule(body, principal.userId); }

  /** El funcionario administra sus salas; el estudiante las descubre para registrarse. */
  @Get()
  @Roles(Role.STAFF, Role.STUDENT)
  list(@CurrentUser() principal: Principal, @Query() query: ListRoomsQueryDto) { return this.rooms.listRooms(principal.userId, query); }

  @Get(':roomId')
  @Roles(Role.STAFF, Role.STUDENT)
  detail(@CurrentUser() principal: Principal, @Param('roomId', new ParseUUIDPipe({ version: '4' })) roomId: string) {
    return this.rooms.getRoom(roomId, principal.userId);
  }

  @Get(':roomId/state')
  @Roles(Role.STUDENT)
  currentState(@CurrentUser() principal: Principal, @Param('roomId', new ParseUUIDPipe({ version: '4' })) roomId: string) {
    return this.rooms.getCurrentState(roomId, principal.userId);
  }

  @Post(':roomId/participants')
  @Roles(Role.STUDENT)
  admitParticipant(@CurrentUser() principal: Principal, @Param('roomId', new ParseUUIDPipe({ version: '4' })) roomId: string) {
    return this.rooms.admitParticipant(roomId, principal.userId);
  }

  /** ADR-0003: el dueño de la sala activa o desactiva las subastas dinamicas. */
  @Patch(':roomId/dynamic-modes')
  @Roles(Role.STAFF)
  setDynamicModes(
    @CurrentUser() principal: Principal,
    @Param('roomId', new ParseUUIDPipe({ version: '4' })) roomId: string,
    @Body() body: SetDynamicModesDto,
  ) {
    return this.dynamicModes.setEnabled(roomId, principal.userId, body.enabled);
  }

  /** ADR-0003: el dueño gira la ruleta de una ronda que aun no empezo. El resultado lo decide el servidor. */
  @Post(':roomId/rounds/:roundId/spin')
  @Roles(Role.STAFF)
  spin(
    @CurrentUser() principal: Principal,
    @Param('roomId', new ParseUUIDPipe({ version: '4' })) roomId: string,
    @Param('roundId', new ParseUUIDPipe({ version: '4' })) roundId: string,
  ) {
    return this.dynamicModes.spin(roomId, roundId, principal.userId);
  }
}
