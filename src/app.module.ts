import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuctionConfig, validateEnv } from './config/auction.config.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { RoomsModule } from './rooms/rooms.module.js';
import { JwtAuthGuard } from './common/jwt-auth.guard.js';
import { RolesGuard } from './common/roles.guard.js';

@Global()
@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }), PrismaModule, RoomsModule],
  providers: [AuctionConfig, JwtAuthGuard, RolesGuard],
})
export class AppModule {}
