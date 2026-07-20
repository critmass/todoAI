import * as fs from 'fs';
import * as path from 'path';
import { MIGRATION_001_SQL } from '../001_initial_schema';
import { MIGRATION_002_SQL } from '../002_skill_layer_schema';
import { MIGRATION_003_SQL } from '../003_multisession_work';

// NNN_*.ts files are generated copies of their NNN_*.sql source (RN/Metro can't import .sql
// files directly - see index.ts's header comment). This guards against the two drifting: the
// .sql file is the verbatim, validated source of truth (brief constraint: never hand-edit the
// DDL), so if this fails, regenerate the .ts from the .sql, don't hand-patch either.
describe('MIGRATION_001_SQL', () => {
  it('is byte-identical to 001_initial_schema.sql', () => {
    const sqlPath = path.join(__dirname, '..', '001_initial_schema.sql');
    const fileContents = fs.readFileSync(sqlPath, 'utf-8');
    expect(MIGRATION_001_SQL).toBe(fileContents);
  });
});

describe('MIGRATION_002_SQL', () => {
  it('is byte-identical to 002_skill_layer_schema.sql', () => {
    const sqlPath = path.join(__dirname, '..', '002_skill_layer_schema.sql');
    const fileContents = fs.readFileSync(sqlPath, 'utf-8');
    expect(MIGRATION_002_SQL).toBe(fileContents);
  });
});

describe('MIGRATION_003_SQL', () => {
  it('is byte-identical to 003_multisession_work.sql', () => {
    const sqlPath = path.join(__dirname, '..', '003_multisession_work.sql');
    const fileContents = fs.readFileSync(sqlPath, 'utf-8');
    expect(MIGRATION_003_SQL).toBe(fileContents);
  });
});
