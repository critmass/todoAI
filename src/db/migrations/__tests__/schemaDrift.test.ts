import * as fs from 'fs';
import * as path from 'path';
import { MIGRATION_001_SQL } from '../001_initial_schema';
import { MIGRATION_002_SQL } from '../002_skill_layer_schema';
import { MIGRATION_003_SQL } from '../003_multisession_work';
import { MIGRATION_004_SQL } from '../004_algorithm_weights_reconciliation';
import { MIGRATION_005_SQL } from '../005_session_runtime';

// NNN_*.ts files are generated copies of their NNN_*.sql source (RN/Metro can't import .sql
// files directly - see index.ts's header comment). This guards against the two drifting: the
// .sql file is the verbatim, validated source of truth (brief constraint: never hand-edit the
// DDL), so if this fails, regenerate the .ts from the .sql, don't hand-patch either.
//
// LINE ENDINGS ARE NORMALIZED ON BOTH SIDES, and that is not a loosened guard - it is the only
// comparison that can ever hold. ECMAScript normalizes CRLF to LF inside a template literal when
// the .ts source is parsed, so on a Windows checkout with core.autocrlf=true (the .sql lands
// CRLF, the .ts lands CRLF, the embedded STRING is LF) a byte-exact compare fails for every
// migration regardless of content. Content drift - the thing this test exists to catch - is
// still caught exactly as before; only the line-ending STYLE, which the .ts physically cannot
// carry, is out of scope. Found running the suite on Windows for task 36.
const lf = (text: string): string => text.replace(/\r\n/g, '\n');

describe('MIGRATION_001_SQL', () => {
  it('is byte-identical to 001_initial_schema.sql', () => {
    const sqlPath = path.join(__dirname, '..', '001_initial_schema.sql');
    const fileContents = fs.readFileSync(sqlPath, 'utf-8');
    expect(lf(MIGRATION_001_SQL)).toBe(lf(fileContents));
  });
});

describe('MIGRATION_002_SQL', () => {
  it('is byte-identical to 002_skill_layer_schema.sql', () => {
    const sqlPath = path.join(__dirname, '..', '002_skill_layer_schema.sql');
    const fileContents = fs.readFileSync(sqlPath, 'utf-8');
    expect(lf(MIGRATION_002_SQL)).toBe(lf(fileContents));
  });
});

describe('MIGRATION_003_SQL', () => {
  it('is byte-identical to 003_multisession_work.sql', () => {
    const sqlPath = path.join(__dirname, '..', '003_multisession_work.sql');
    const fileContents = fs.readFileSync(sqlPath, 'utf-8');
    expect(lf(MIGRATION_003_SQL)).toBe(lf(fileContents));
  });
});

describe('MIGRATION_004_SQL', () => {
  it('is byte-identical to 004_algorithm_weights_reconciliation.sql', () => {
    const sqlPath = path.join(__dirname, '..', '004_algorithm_weights_reconciliation.sql');
    const fileContents = fs.readFileSync(sqlPath, 'utf-8');
    expect(lf(MIGRATION_004_SQL)).toBe(lf(fileContents));
  });
});

describe('MIGRATION_005_SQL', () => {
  it('is byte-identical to 005_session_runtime.sql', () => {
    const sqlPath = path.join(__dirname, '..', '005_session_runtime.sql');
    const fileContents = fs.readFileSync(sqlPath, 'utf-8');
    expect(lf(MIGRATION_005_SQL)).toBe(lf(fileContents));
  });
});
