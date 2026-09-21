import { Module } from '@nestjs/common';
import { CatalogReservationClient } from './catalog-reservation.client.js';
@Module({ providers: [CatalogReservationClient], exports: [CatalogReservationClient] })
export class EventsModule {}
