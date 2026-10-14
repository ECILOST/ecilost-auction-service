import { Module } from '@nestjs/common';
import { EventsModule } from '../events/events.module.js';
import { AutoBidsService } from './auto-bids.service.js';
import { BidsService } from './bids.service.js';
import { BidsController } from './bids.controller.js';
import { BuyNowService } from './buy-now.service.js';
@Module({ imports: [EventsModule], controllers: [BidsController], providers: [BidsService, AutoBidsService, BuyNowService], exports: [BidsService, AutoBidsService] }) export class BidsModule {}
