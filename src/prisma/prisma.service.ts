import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { AuctionConfig } from '../config/auction.config.js';
import { PrismaClient } from '../generated/prisma/client.js';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor(config: AuctionConfig) { super({ adapter: new PrismaPg(config.databaseUrl, { schema: config.databaseSchema }) }); }
  onModuleInit(): Promise<void> { return this.$connect(); }
  onModuleDestroy(): Promise<void> { return this.$disconnect(); }
}
