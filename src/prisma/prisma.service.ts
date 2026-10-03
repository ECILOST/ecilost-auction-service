import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { AuctionConfig } from '../config/auction.config.js';
import { PrismaClient } from '../generated/prisma/client.js';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  /**
   * `schema` solo califica las consultas del cliente Prisma; el SQL crudo (`$queryRaw`,
   * donde viven la puja serializada y el cierre de ronda) resuelve las tablas con el
   * `search_path` de la sesion. Se fija al mismo esquema para que ambos lean y escriban lo
   * mismo: sin esto, el SQL crudo caia en el esquema con el nombre del usuario.
   */
  constructor(config: AuctionConfig) {
    super({
      adapter: new PrismaPg(
        { connectionString: config.databaseUrl, options: `-c search_path="${config.databaseSchema.replaceAll('"', '')}"` },
        { schema: config.databaseSchema },
      ),
    });
  }
  onModuleInit(): Promise<void> { return this.$connect(); }
  onModuleDestroy(): Promise<void> { return this.$disconnect(); }
}
