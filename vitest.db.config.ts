import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// DB-backed suites only. Run with `bun run test:db` against a LOCAL Postgres
// (the suites create/point at a local test database). Kept separate from the
// default config so plain `bun test` / CI never needs — or touches — a database.
const typesSrc = fileURLToPath(
  new URL('../characterbuilder_types/src/index.ts', import.meta.url)
);

export default defineConfig({
  resolve: {
    alias: existsSync(typesSrc)
      ? { '@sudobility/characterbuilder_types': typesSrc }
      : {},
  },
  test: {
    include: ['src/**/*.db.test.ts'],
    environment: 'node',
    testTimeout: 30000,
    fileParallelism: false,
    server: {
      deps: {
        inline: [
          /@sudobility\/consumables_service/,
          /@sudobility\/entity_service/,
        ],
      },
    },
  },
});
