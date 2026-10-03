import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.int-spec.ts'],
    // Aplica las migraciones una vez sobre un esquema propio de las pruebas.
    globalSetup: ['./test/global-setup.ts'],
    // Las pruebas comparten una sola base: ejecutarlas en paralelo las haria interferir.
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
