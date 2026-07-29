/* eslint-env jest */
/**
 * Task 24 — Jest setup.
 *
 * Two native modules are stubbed here, and only here, so `__tests__/App.test.tsx` can mount the
 * real root component. Both throw at IMPORT time outside a real RN runtime:
 *
 *   @op-engineering/op-sqlite — its RN entry point requires NativeModules.OPSQLite to exist.
 *   llama.rn                  — same shape, for the model.
 *
 * NOTHING ELSE IN THE SUITE DEPENDS ON THESE STUBS. Every repository, migration and service test
 * runs against a real SQLite engine through `src/db/testUtils/sqliteTestConnection.ts`
 * (better-sqlite3), and every model-facing test uses `MockLLMProvider`. These exist purely so that
 * importing the app's own entry point is not itself a crash.
 */

jest.mock('@op-engineering/op-sqlite', () => ({
  ANDROID_DATABASE_PATH: '/mock/databases',
  open: () => ({
    execute: async () => ({ rows: [], rowsAffected: 0 }),
    executeSync: () => ({ rows: [], rowsAffected: 0 }),
    transaction: async () => undefined,
    close: () => undefined,
  }),
}));

jest.mock('llama.rn', () => ({
  initLlama: async () => {
    throw new Error('llama.rn is not available under Jest');
  },
}));
