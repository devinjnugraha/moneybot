import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globalSetup: ['./tests/global-setup.ts'],
    setupFiles: ['./tests/setup.ts'],
    // DB integration tests are I/O-bound; serialize to avoid pool contention noise
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
