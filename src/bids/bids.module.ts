import { Module } from '@nestjs/common';
import { EventsModule } from '../events/events.module.js';
import { BidsService } from './bids.service.js';
import { BidsController } from './bids.controller.js';
@Module({ imports: [EventsModule], controllers: [BidsController], providers: [BidsService], exports: [BidsService] }) export class BidsModule {}
