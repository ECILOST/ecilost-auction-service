import { execFileSync } from 'node:child_process';
import { integrationDatabaseUrl } from './database.js';

/**
 * Deja el esquema de pruebas (`auction_it`, aparte del de desarrollo) al dia antes de la
 * primera prueba. Requiere el Postgres de auction arriba: `docker compose up -d`.
 */
export default function setup(): void {
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, DATABASE_URL: integrationDatabaseUrl },
  });
}
