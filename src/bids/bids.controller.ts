import { Body, Controller, Param, Post, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../common/current-user.decorator.js';
import { JwtAuthGuard } from '../common/jwt-auth.guard.js';
import { type Principal, Role } from '../common/principal.js';
import { Roles } from '../common/roles.decorator.js';
import { RolesGuard } from '../common/roles.guard.js';
import { BidsService } from './bids.service.js';
import { PlaceBidDto } from './place-bid.dto.js';
@Controller('rounds/:roundId/bids') @UseGuards(JwtAuthGuard, RolesGuard) @Roles(Role.STUDENT)
export class BidsController {
  constructor(private readonly bids: BidsService) {}
  @Post() place(@Param('roundId') roundId: string, @CurrentUser() user: Principal, @Body() body: PlaceBidDto) { return this.bids.place(roundId, user.userId, body.amount); }
}
