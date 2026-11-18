import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Prefer sibling source locally; else the published @sudobility/characterbuilder_types.
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
    include: ['src/**/*.test.ts'],
    // Database-backed suites (*.db.test.ts) are never collected by the default
    // run — this is what keeps CI (and local `bun test`) off a database, and
    // in particular off the remote DB that `.env` DATABASE_URL points at. Run
    // them explicitly against a local DB with `vitest **/*.db.test.ts`.
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.db.test.ts'],
    environment: 'node',
    testTimeout: 15000,
    // consumables_service + entity_service published dist use directory imports
    // ('./schema') that Node ESM rejects but Bun/Vite resolve — inline them so
    // Vite transforms them.
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
