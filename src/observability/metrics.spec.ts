import { Controller, Get, Module, Param, UnauthorizedException, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterEach, describe, expect, it } from 'vitest';
import { installMetrics } from './metrics.js';

@Controller('rooms')
class RoomsController {
  @Get(':roomId')
  find(@Param('roomId') roomId: string) {
    return { roomId };
  }

  @Get(':roomId/private')
  denied() {
    throw new UnauthorizedException();
  }
}

@Module({ controllers: [RoomsController] })
class TestModule {}

async function start(gauges = [] as Parameters<typeof installMetrics>[2]) {
  const app = await NestFactory.create(TestModule, { logger: false });
  installMetrics(app, 'test', gauges);
  await app.listen(0);
  const url = await app.getUrl();
  return { app, url: url.replace('[::1]', 'localhost') };
}

describe('installMetrics', () => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
    delete process.env.METRICS_ENABLED;
  });

  it('no expone nada si METRICS_ENABLED no es true', async () => {
    const started = await start();
    app = started.app;
    expect((await fetch(`${started.url}/metrics`)).status).toBe(404);
  });

  it('etiqueta la duracion con la plantilla de ruta, incluidas las respuestas de error', async () => {
    process.env.METRICS_ENABLED = 'true';
    const started = await start();
    app = started.app;

    await fetch(`${started.url}/rooms/0b6f3c1e-1111-4222-8333-944445555666`);
    await fetch(`${started.url}/rooms/abc/private`);
    await fetch(`${started.url}/nope`);
    const body = await (await fetch(`${started.url}/metrics`)).text();

    expect(body).toMatch(/http_server_request_duration_seconds_count\{[^}]*route="\/rooms\/:roomId"[^}]*status_code="200"[^}]*\} 1/);
    expect(body).toMatch(/route="\/rooms\/:roomId\/private"[^}]*status_code="401"/);
    expect(body).toMatch(/route="unmatched"[^}]*status_code="404"/);
    expect(body).not.toContain('0b6f3c1e');
    expect(body).toContain('service="test"');
    expect(body).toContain('nodejs_eventloop_lag_seconds');
  });

  it('lee los gauges adicionales en cada scrape', async () => {
    process.env.METRICS_ENABLED = 'true';
    let sockets = 3;
    const started = await start([{ name: 'realtime_connected_sockets', help: 'sockets', read: () => sockets }]);
    app = started.app;

    expect(await (await fetch(`${started.url}/metrics`)).text()).toMatch(/realtime_connected_sockets\{[^}]*\} 3/);
    sockets = 7;
    expect(await (await fetch(`${started.url}/metrics`)).text()).toMatch(/realtime_connected_sockets\{[^}]*\} 7/);
  });
});
