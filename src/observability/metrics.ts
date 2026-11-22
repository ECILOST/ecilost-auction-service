import type { INestApplication } from '@nestjs/common';
import { Gauge, Histogram, Registry, collectDefaultMetrics } from '@prometheus-io/client';

export const METRICS_PATH = '/metrics';

/** Cubre desde lecturas en cache (ms) hasta pujas encoladas tras el lock de ronda (s). */
const DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

/** Un valor que se lee en el momento del scrape, p. ej. sockets conectados. */
export interface MetricsGauge {
  name: string;
  help: string;
  read: () => number;
}

interface HttpRequest {
  method: string;
  path: string;
  baseUrl: string;
  route?: { path: string };
}

interface HttpResponse {
  statusCode: number;
  on(event: 'finish', listener: () => void): void;
  setHeader(name: string, value: string): void;
  end(body: string): void;
}

/**
 * Expone metricas Prometheus en `GET /metrics` para las pruebas de rendimiento de
 * ecilost-load-tests. Solo se activa con `METRICS_ENABLED=true`: en Azure la ingress es
 * publica y el endpoint no lleva autenticacion, asi que por defecto no existe.
 *
 * Se monta como middleware de Express antes que el router de Nest para medir tambien las
 * respuestas que cortan los guards (401/403). Va fuera del prefijo global: en todos los
 * servicios la ruta es la misma.
 */
export function installMetrics(
  app: Pick<INestApplication, 'use'>,
  service: string,
  gauges: MetricsGauge[] = [],
): Registry | undefined {
  if (process.env.METRICS_ENABLED !== 'true') return undefined;

  const registry = new Registry();
  registry.setDefaultLabels({ service });
  // CPU, memoria residente, heap, GC y retraso del event loop del proceso Node.
  collectDefaultMetrics({ register: registry, eventLoopMonitoringPrecision: 10 });

  const duration = new Histogram({
    name: 'http_server_request_duration_seconds',
    help: 'Duracion de las peticiones HTTP atendidas, por plantilla de ruta y estado.',
    labelNames: ['method', 'route', 'status_code'],
    buckets: DURATION_BUCKETS,
    registers: [registry],
  });

  for (const gauge of gauges) {
    const metric = new Gauge({
      name: gauge.name,
      help: gauge.help,
      registers: [],
      collect() {
        this.set(gauge.read());
      },
    });
    registry.registerMetric(metric);
  }

  app.use((req: HttpRequest, res: HttpResponse, next: () => void) => {
    if (req.path === METRICS_PATH && req.method === 'GET') {
      void registry.metrics().then((body) => {
        res.setHeader('Content-Type', registry.contentType);
        res.end(body);
      }).catch(() => { res.statusCode = 500; res.end('Metrics collection failed'); });
      return;
    }
    const end = duration.startTimer();
    res.on('finish', () => {
      // La plantilla (/rooms/:roomId) y no la URL: con ids en la etiqueta cada sala seria
      // una serie nueva. Lo que no casa con ninguna ruta se agrupa en una sola.
      const route = req.route ? `${req.baseUrl}${req.route.path}` : 'unmatched';
      end({ method: req.method, route, status_code: res.statusCode });
    });
    next();
  });

  return registry;
}
