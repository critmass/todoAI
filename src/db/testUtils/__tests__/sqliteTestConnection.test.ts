// Task 59 — the test connection must hand callers a driver error that is a REAL `Error` of the
// realm the caller lives in.
//
// WHY THIS EXISTS. better-sqlite3's `SqliteError` (node_modules/better-sqlite3/lib/sqlite-error.js)
// is a hand-rolled pseudo-Error: a plain `function` whose prototype is patched onto `Error.prototype`
// with `Object.setPrototypeOf`. Its instances therefore have no `[[ErrorData]]` internal slot
// (`Object.prototype.toString` says `[object Object]`, not `[object Error]`) and their chain ends at
// whichever realm's `Error.prototype` was current when the module loaded. `database.js` then hands
// that constructor to the NATIVE addon via `addon.setErrorConstructor(SqliteError)`, and Node caches
// native addons per PROCESS, not per Jest realm — so every error thrown from native code in a Jest
// worker is built from the constructor belonging to whichever test file loaded better-sqlite3 FIRST
// in that process. In every later file `err instanceof Error` is false, Jest's `isError()` falls
// through to that cross-realm check, and `.rejects.toThrow()` reports "Received function did not
// throw" for an insert that genuinely did throw. Diagnosed in
// docs/eval/housekeeping_2026-08-22_report.md Part B; fixed at this boundary by task 59.
//
// The tests below reproduce that shape deterministically with a genuine second realm (`vm`), so they
// do not depend on this file's position in the run the way the original symptom did.

import type Database from 'better-sqlite3';
import { wrapDatabase } from '../sqliteTestConnection';
import { foreignRealmSqliteError } from '../foreignRealmError';

/** A better-sqlite3 handle whose every driver entry point throws `thrown`. */
function throwingHandle(thrown: unknown): Database.Database {
  const handle = {
    prepare: () => {
      throw thrown;
    },
    exec: () => {
      throw thrown;
    },
    inTransaction: false,
    close: () => undefined,
  };
  return handle as unknown as Database.Database;
}

describe('wrapDatabase — driver error normalisation (task 59)', () => {
  const RAW = foreignRealmSqliteError('Circular dependency detected', 'SQLITE_CONSTRAINT_TRIGGER');

  it('the raw driver error really is unrecognisable as an Error here (the precondition)', () => {
    // If this ever stops holding, better-sqlite3 has started throwing real Errors and the
    // normalisation below is no longer load-bearing — which is worth knowing, so assert it.
    expect(RAW instanceof Error).toBe(false);
    expect(Object.prototype.toString.call(RAW)).toBe('[object Object]');
    // ...yet it stringifies fine, which is why the `String(err)` fallbacks in production still work.
    expect(String(RAW)).toBe('SqliteError: Circular dependency detected');
  });

  it('execute() rejects with a real Error, so .rejects.toThrow() matches the message', async () => {
    const conn = wrapDatabase(throwingHandle(RAW));
    await expect(
      conn.execute('INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES (?, ?)', [
        3, 1,
      ]),
    ).rejects.toThrow(/Circular dependency detected/);
  });

  it('preserves name, code and the driver stack while normalising', async () => {
    const conn = wrapDatabase(throwingHandle(RAW));
    const thrown = await conn.execute('SELECT 1').then(
      () => null,
      (err: unknown) => err,
    );
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).toMatchObject({
      name: 'SqliteError',
      message: 'Circular dependency detected',
      code: 'SQLITE_CONSTRAINT_TRIGGER',
    });
    expect((thrown as Error).stack).toContain('Database.prepare');
  });

  it('normalises driver errors raised by transaction control statements too', async () => {
    const conn = wrapDatabase(throwingHandle(RAW));
    await expect(conn.transaction(async () => undefined)).rejects.toThrow(
      /Circular dependency detected/,
    );
  });

  it('leaves a real Error of this realm exactly as it is (no re-wrapping)', async () => {
    class AppError extends Error {}
    const original = new AppError('app-defined');
    const conn = wrapDatabase(throwingHandle(original));
    const thrown = await conn.execute('SELECT 1').then(
      () => null,
      (err: unknown) => err,
    );
    expect(thrown).toBe(original); // identity, not a copy — typed catches still work
    expect(thrown).toBeInstanceOf(AppError);
  });

  it('does not touch an error thrown by the caller inside transaction()', async () => {
    class AppError extends Error {}
    const original = new AppError('from the callback');
    const handle = {
      prepare: () => {
        throw new Error('unused');
      },
      exec: () => undefined,
      inTransaction: false,
      close: () => undefined,
    } as unknown as Database.Database;
    const conn = wrapDatabase(handle);
    const thrown = await conn
      .transaction(async () => {
        throw original;
      })
      .then(
        () => null,
        (err: unknown) => err,
      );
    expect(thrown).toBe(original);
  });
});
