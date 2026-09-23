import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnv } from './config/auction.config.js';
import { AuctionConfigModule } from './config/auction-config.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { RoomsModule } from './rooms/rooms.module.js';
import { BidsModule } from './bids/bids.module.js';
import { JwtAuthGuard } from './common/jwt-auth.guard.js';
import { RolesGuard } from './common/roles.guard.js';

@Global()
@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }), AuctionConfigModule, PrismaModule, RoomsModule, BidsModule],
  providers: [JwtAuthGuard, RolesGuard],
})
export class AppModule {}
