import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { installMetrics } from './observability/metrics.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  installMetrics(app, 'auction');
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
  await app.listen(process.env.PORT ?? 3003);
}

void bootstrap();
