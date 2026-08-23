// Test-only `DbOperations` (task 14) backed by better-sqlite3 over REAL FILES in a temp directory.
// NOT imported by any production/app code.
//
// Why files and not ':memory:': the whole point of task 14's Phase A is a ladder exercised against
// a genuinely damaged database. `VACUUM INTO`, `ATTACH`, `PRAGMA integrity_check` and "the file is
// gone" are all file-level facts, and a corruption test that does not corrupt bytes is a test of
// the mock. `corruptDatabaseFile` below writes over real pages; the resulting
// `integrity_check` failures are SQLite's, not a stub's.
//
// Deliberately not under a __tests__ directory: Jest's default testMatch treats every file there as
// a suite, and this file exports helpers.
//
// ⚠ WHAT THIS DOUBLE DOES NOT PROVE: it is better-sqlite3 3.5x on a desktop filesystem, not
// op-sqlite's bundled SQLite on Android f2fs. Error strings, the exact damage a truncated file
// produces, and whether a real full-disk condition surfaces as SQLITE_FULL at the same statement
// are all device facts. That is precisely what task 14's Phase B is for.

import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { DbFileRef, DbOperations, ManagedDb } from '../../services/backup/types';
import { normaliseDriverError, wrapDatabase } from './sqliteTestConnection';

export interface FileDbOperations extends DbOperations {
  /** The temp directory every unqualified ref resolves inside. */
  root: string;
  pathFor(ref: DbFileRef): string;
  exists(ref: DbFileRef): boolean;
  /** When true, every `VACUUM INTO` fails the way a full disk does. This is the injected "no
   *  space" the brief (§6) asks for — the condition cannot be produced any other way headless. */
  setDiskFull(full: boolean): void;
  /** Makes matching statements fail the way an unreadable page does. This is how a table that is
   *  present but CORRUPT is modelled: byte-level damage makes a file unreadable as a whole, which
   *  tests the ladder's outer branch but never salvage's per-table degradation. */
  setQueryFault(match: ((sql: string) => boolean) | null): void;
  /** Handles opened and not yet closed. Asserted in tests so the ladder cannot leak connections. */
  openHandles(): number;
  cleanup(): void;
}

class DiskFullError extends Error {
  code = 'SQLITE_FULL';
  constructor() {
    super('database or disk is full');
    this.name = 'SqliteError';
  }
}

class MalformedError extends Error {
  code = 'SQLITE_CORRUPT';
  constructor() {
    super('database disk image is malformed');
    this.name = 'SqliteError';
  }
}

export function createFileDbOperations(root?: string): FileDbOperations {
  const directory = root ?? fs.mkdtempSync(path.join(os.tmpdir(), 'todoai-task14-'));
  fs.mkdirSync(directory, { recursive: true });
  let diskFull = false;
  let queryFault: ((sql: string) => boolean) | null = null;
  let open = 0;

  function pathFor(ref: DbFileRef): string {
    const base = ref.location ?? directory;
    fs.mkdirSync(base, { recursive: true });
    return path.join(base, ref.name);
  }

  function removeFiles(target: string): void {
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      try {
        fs.rmSync(target + suffix, { force: true });
      } catch {
        /* already gone */
      }
    }
  }

  return {
    root: directory,
    pathFor,
    exists: (ref) => fs.existsSync(pathFor(ref)),
    setDiskFull: (full) => {
      diskFull = full;
    },
    setQueryFault: (match) => {
      queryFault = match;
    },
    openHandles: () => open,
    cleanup: () => {
      // Best effort: on Windows a still-open SQLite handle makes the directory undeletable, and a
      // leaked handle is a test-hygiene problem, not a reason to fail the assertion that found it.
      try {
        fs.rmSync(directory, { recursive: true, force: true });
      } catch {
        /* the OS will reclaim the temp directory */
      }
    },

    open(ref: DbFileRef): ManagedDb {
      const target = pathFor(ref);
      let handle: Database.Database | null = null;
      let openError: unknown = null;
      try {
        handle = new Database(target);
        handle.pragma('foreign_keys = ON'); // constraint #9, same as the real adapter
        open += 1;
      } catch (err) {
        // A file too damaged to open at all is a real state; model it rather than throwing out of
        // `open()`, which op-sqlite does not do either. Normalised for the same reason every other
        // driver error is (task 59, see sqliteTestConnection.normaliseDriverError): this is the one
        // path that hands a RAW better-sqlite3 error to a test, and a raw one is invisible to
        // `.rejects.toThrow()` in any file that did not load the driver first.
        openError = normaliseDriverError(err);
      }

      const connection = handle ? wrapDatabase(handle) : null;

      return {
        execute: async (query, params) => {
          if (openError) throw openError;
          if (diskFull && /^\s*VACUUM\s+INTO/i.test(query)) throw new DiskFullError();
          if (queryFault && queryFault(query)) throw new MalformedError();
          return connection!.execute(query, params);
        },
        transaction: async (fn) => {
          if (openError) throw openError;
          return connection!.transaction(fn);
        },
        close: () => {
          if (handle && handle.open) {
            handle.close();
            open -= 1;
            handle = null;
          }
        },
        delete: () => {
          if (handle && handle.open) {
            handle.close();
            open -= 1;
            handle = null;
          }
          removeFiles(target);
        },
        path: () => target,
      };
    },
  };
}

export type CorruptionMode =
  /** Destroys the 16-byte "SQLite format 3" header — the file stops being a database at all. */
  | 'header'
  /** Overwrites a b-tree page well past the header, so the file opens and fails on read. */
  | 'page'
  /** Garbles only the FINAL page. This is the partial-damage case salvage exists for: the database
   *  still describes itself and most of it reads, but `integrity_check` fails. Anything broader
   *  than this against THIS schema takes the schema out too — `sqlite_master` for ~40 tables has
   *  pages spread throughout the file, so a "corrupt the last third" mode makes `ATTACH` itself
   *  return SQLITE_CORRUPT and there is nothing left to salvage. Measured, not assumed. */
  | 'lastPage'
  /** Cuts the file in half, the shape a partial write or a full disk leaves behind. */
  | 'truncate';

/** Damages a database FILE. Every handle to it must be closed first — SQLite caches pages. */
export function corruptDatabaseFile(target: string, mode: CorruptionMode = 'page'): void {
  const bytes = fs.readFileSync(target);
  if (mode === 'header') {
    bytes.fill(0x00, 0, 16);
    fs.writeFileSync(target, bytes);
    return;
  }
  if (mode === 'lastPage') {
    const pageSize = bytes.readUInt16BE(16) || 4096;
    const start = bytes.length - pageSize;
    if (start > 0) bytes.fill(0xa5, start + 8, Math.min(start + 200, bytes.length));
    fs.writeFileSync(target, bytes);
    return;
  }
  if (mode === 'truncate') {
    fs.writeFileSync(target, bytes.subarray(0, Math.floor(bytes.length / 2)));
    return;
  }
  // 'page' — garble the interior of every page after the first, leaving the header intact so the
  // file still opens and the damage surfaces as a read failure.
  const pageSize = bytes.readUInt16BE(16) || 4096;
  for (let offset = pageSize; offset + 64 < bytes.length; offset += pageSize) {
    bytes.fill(0xa5, offset + 8, offset + 64);
  }
  fs.writeFileSync(target, bytes);
}
