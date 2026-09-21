import { Module } from '@nestjs/common';
import { RoomsController } from './rooms.controller.js';
import { RoomsService } from './rooms.service.js';
import { EventsModule } from '../events/events.module.js';
@Module({ imports: [EventsModule], controllers: [RoomsController], providers: [RoomsService] })
export class RoomsModule {}
