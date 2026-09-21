import { Global, Module } from '@nestjs/common';
import { AuctionConfig } from './auction.config.js';

@Global()
@Module({ providers: [AuctionConfig], exports: [AuctionConfig] })
export class AuctionConfigModule {}
