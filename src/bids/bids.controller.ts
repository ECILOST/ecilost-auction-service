import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../common/current-user.decorator.js';
import { JwtAuthGuard } from '../common/jwt-auth.guard.js';
import { type Principal, Role } from '../common/principal.js';
import { Roles } from '../common/roles.decorator.js';
import { RolesGuard } from '../common/roles.guard.js';
import { AutoBidsService } from './auto-bids.service.js';
import { BidsService } from './bids.service.js';
import { ConfigureAutoBidDto } from './configure-auto-bid.dto.js';
import { PlaceBidDto } from './place-bid.dto.js';

@Controller('rounds/:roundId') @UseGuards(JwtAuthGuard, RolesGuard) @Roles(Role.STUDENT)
export class BidsController {
  constructor(private readonly bids: BidsService, private readonly autoBids: AutoBidsService) {}

  @Post('bids')
  async place(@Param('roundId') roundId: string, @CurrentUser() user: Principal, @Body() body: PlaceBidDto) {
    const placed = await this.bids.place(roundId, user.userId, body.amount);
    // Las pujas automaticas responden despues de confirmar la manual; el cliente se entera
    // por el canal en vivo, sin esperar aqui.
    void this.autoBids.resolve(roundId);
    return placed;
  }

  /** HU-22: declarar, cambiar o desactivar el limite de la puja automatica en la ronda. */
  @Put('auto-bid')
  configureAutoBid(
    @Param('roundId', new ParseUUIDPipe({ version: '4' })) roundId: string,
    @CurrentUser() user: Principal,
    @Body() body: ConfigureAutoBidDto,
  ) {
    return this.autoBids.configure(roundId, user.userId, body);
  }

  @Get('auto-bid')
  autoBid(@Param('roundId', new ParseUUIDPipe({ version: '4' })) roundId: string, @CurrentUser() user: Principal) {
    return this.autoBids.view(roundId, user.userId);
  }
}
