// Task 59 — a deterministic stand-in for the driver error that broke `.rejects.toThrow()`.
// Test-only. NOT imported by any production/app code. Deliberately not under a __tests__ directory,
// for the same reason as sqliteTestConnection.ts: Jest's testMatch collects every file there as a
// suite, and this one exports a helper.
//
// better-sqlite3's `SqliteError` (node_modules/better-sqlite3/lib/sqlite-error.js) is a hand-rolled
// pseudo-Error: a plain `function` whose prototype is grafted onto `Error.prototype` with
// `Object.setPrototypeOf`, so instances have NO `[[ErrorData]]` internal slot. `lib/database.js`
// hands that constructor to the native addon (`addon.setErrorConstructor`), and Node caches native
// addons per PROCESS, not per Jest realm — so in every test file except the one that loaded the
// driver first, the thrown error's chain ends at a FOREIGN `Error.prototype` and
// `err instanceof Error` is false. Reproducing that with a real second realm (`vm`) makes the
// condition deterministic instead of dependent on a suite's position in the run.
// Diagnosis: docs/eval/housekeeping_2026-08-22_report.md Part B.

import vm from 'vm';

const FOREIGN_ERROR_PROTOTYPE = (vm.runInNewContext('Error') as ErrorConstructor).prototype;

export interface DriverError {
  message: string;
  code: string;
  name: string;
  stack?: string;
}

/** A driver error shaped exactly like a cross-realm better-sqlite3 `SqliteError`: non-enumerable
 *  `message`/`name` descriptors, a `code`, a driver stack, and a prototype chain terminating at
 *  another realm's `Error.prototype` — so `value instanceof Error` is false here while
 *  `String(value)` still yields `"SqliteError: <message>"`. */
export function foreignRealmSqliteError(message: string, code: string): DriverError {
  const proto = Object.create(FOREIGN_ERROR_PROTOTYPE) as object;
  Object.defineProperty(proto, 'name', {
    value: 'SqliteError',
    writable: true,
    enumerable: false,
    configurable: true,
  });
  const err = Object.create(proto) as DriverError;
  Object.defineProperty(err, 'message', {
    value: message,
    writable: true,
    enumerable: false,
    configurable: true,
  });
  err.code = code;
  err.stack = `SqliteError: ${message}\n    at Database.prepare (<native>)`;
  return err;
}
