import { Module } from '@nestjs/common';
import { EventsModule } from '../events/events.module.js';
import { AutoBidsService } from './auto-bids.service.js';
import { BidsService } from './bids.service.js';
import { BidsController } from './bids.controller.js';
import { BuyNowService } from './buy-now.service.js';
import { DutchService } from './dutch.service.js';
import { SealedBidsService } from './sealed-bids.service.js';
@Module({ imports: [EventsModule], controllers: [BidsController], providers: [BidsService, AutoBidsService, BuyNowService, DutchService, SealedBidsService], exports: [BidsService, AutoBidsService] }) export class BidsModule {}
