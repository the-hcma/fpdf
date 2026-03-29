import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'src/__tests__/**/*.test.ts'],
    exclude: ['src/__tests__/fixtures/**'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/__tests__/**', 'src/public/**', 'src/types.ts'],
      thresholds: {
        lines: 80,
        branches: 73,
        functions: 80,
        statements: 80,
      },
      reporter: ['text', 'lcov'],
    },
  },
});
