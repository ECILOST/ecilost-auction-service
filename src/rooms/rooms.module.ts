import { Module } from '@nestjs/common';
import { RoomsController } from './rooms.controller.js';
import { RoomsService } from './rooms.service.js';
@Module({ controllers: [RoomsController], providers: [RoomsService] })
export class RoomsModule {}
