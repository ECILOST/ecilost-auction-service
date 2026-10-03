import { Module } from '@nestjs/common';
import { EventsModule } from '../events/events.module.js';
import { AutoBidsService } from './auto-bids.service.js';
import { BidsService } from './bids.service.js';
import { BidsController } from './bids.controller.js';
@Module({ imports: [EventsModule], controllers: [BidsController], providers: [BidsService, AutoBidsService], exports: [BidsService, AutoBidsService] }) export class BidsModule {}
