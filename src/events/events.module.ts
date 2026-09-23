import { Module } from '@nestjs/common';
import { CatalogReservationClient } from './catalog-reservation.client.js';
import { WalletHoldClient } from './wallet-hold.client.js';
@Module({ providers: [CatalogReservationClient, WalletHoldClient], exports: [CatalogReservationClient, WalletHoldClient] })
export class EventsModule {}
