/* eslint-env jest, node */
const Database = require('better-sqlite3');
const { isJunkTag, parseTagArray, scanDatabase, purgeDatabase } = require('../purge-junk-tags');

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE tasks (
      id INTEGER PRIMARY KEY,
      title TEXT,
      status TEXT DEFAULT 'active',
      context_tags TEXT,
      tool_requirements TEXT
    );
  `);
  return db;
}

describe('isJunkTag — the exact firstChar rule task 37 now enforces at generation time', () => {
  it('flags a leading-separator artifact (the confirmed ":mixing" / ":episode" class)', () => {
    expect(isJunkTag(':mixing')).toBe(true);
    expect(isJunkTag(':episode')).toBe(true);
    expect(isJunkTag('-oops')).toBe(true);
    expect(isJunkTag(' leading-space')).toBe(true);
  });

  it('does NOT flag a phrasing-failure tag ("work_on_it_until_did" is a tracked signal, not junk)', () => {
    expect(isJunkTag('work_on_it_until_did')).toBe(false);
  });

  it('does not flag ordinary tags', () => {
    expect(isJunkTag('home')).toBe(false);
    expect(isJunkTag('office')).toBe(false);
    expect(isJunkTag('phone123')).toBe(false);
  });

  it('is false for non-strings and the empty string (nothing to remove)', () => {
    expect(isJunkTag('')).toBe(false);
    expect(isJunkTag(null)).toBe(false);
    expect(isJunkTag(undefined)).toBe(false);
    expect(isJunkTag(5)).toBe(false);
  });
});

describe('parseTagArray', () => {
  it('parses a clean JSON array of strings', () => {
    expect(parseTagArray('["home","office"]')).toEqual(['home', 'office']);
  });

  it('treats null/absent as an empty array (nothing to scan, not an error)', () => {
    expect(parseTagArray(null)).toEqual([]);
  });

  it('returns null (for manual review) on malformed or non-string-array JSON', () => {
    expect(parseTagArray('not json')).toBeNull();
    expect(parseTagArray('{"a":1}')).toBeNull();
    expect(parseTagArray('[1,2,3]')).toBeNull();
  });
});

describe('scanDatabase — report only, makes no writes', () => {
  let db;
  beforeEach(() => {
    db = makeDb();
  });
  afterEach(() => db.close());

  it('finds leading-separator junk and leaves the row untouched', () => {
    const original = JSON.stringify([':mixing', 'studio']);
    db.prepare('INSERT INTO tasks (id, title, context_tags, tool_requirements) VALUES (1, ?, ?, ?)').run(
      'Mix track',
      original,
      '[]',
    );

    const report = scanDatabase(db);
    expect(report.tasksScanned).toBe(1);
    expect(report.totalJunkEntries).toBe(1);
    expect(report.findings).toEqual([
      {
        taskId: 1,
        title: 'Mix track',
        status: 'active',
        column: 'context_tags',
        junk: [':mixing'],
        kept: ['studio'],
      },
    ]);

    // Report-only: the row is NOT modified.
    const row = db.prepare('SELECT context_tags FROM tasks WHERE id = 1').get();
    expect(row.context_tags).toBe(original);
  });

  it('leaves "work_on_it_until_did" alone — not in scope for this defect class', () => {
    db.prepare(
      "INSERT INTO tasks (id, title, context_tags) VALUES (1, 'Write chapter', '[\"work_on_it_until_did\"]')",
    ).run();
    const report = scanDatabase(db);
    expect(report.findings).toHaveLength(0);
  });

  it('scans both context_tags and tool_requirements, and any task status', () => {
    db.prepare(
      "INSERT INTO tasks (id, title, status, context_tags, tool_requirements) VALUES (1, 'Old episode note', 'deleted', '[\":episode\"]', '[\":laptop\"]')",
    ).run();
    const report = scanDatabase(db);
    expect(report.findings).toHaveLength(2);
    expect(report.findings.map((f) => f.column).sort()).toEqual(['context_tags', 'tool_requirements']);
  });

  it('reports (does not silently coerce) malformed JSON for manual review', () => {
    db.prepare("INSERT INTO tasks (id, title, context_tags) VALUES (1, 'Bad row', 'not json')").run();
    const report = scanDatabase(db);
    expect(report.findings).toHaveLength(0);
    expect(report.unparseable).toEqual([{ taskId: 1, title: 'Bad row', column: 'context_tags', raw: 'not json' }]);
  });

  it('reports zero findings on a clean database', () => {
    db.prepare("INSERT INTO tasks (id, title, context_tags) VALUES (1, 'Clean', '[\"home\"]')").run();
    expect(scanDatabase(db).totalJunkEntries).toBe(0);
  });
});

describe('purgeDatabase — the destructive mode', () => {
  let db;
  beforeEach(() => {
    db = makeDb();
  });
  afterEach(() => db.close());

  it('removes only the junk entries, keeping legitimate tags in the same column', () => {
    db.prepare(
      "INSERT INTO tasks (id, title, context_tags) VALUES (1, 'Mix track', '[\":mixing\",\"studio\",\":episode\"]')",
    ).run();

    const result = purgeDatabase(db);
    expect(result.applied).toBe(true);
    expect(result.tasksUpdated).toBe(1);

    const row = db.prepare('SELECT context_tags FROM tasks WHERE id = 1').get();
    expect(JSON.parse(row.context_tags)).toEqual(['studio']);
  });

  it('never touches tool_requirements when only context_tags has junk (and vice versa)', () => {
    db.prepare(
      "INSERT INTO tasks (id, title, context_tags, tool_requirements) VALUES (1, 'T', '[\":junk\"]', '[\"laptop\"]')",
    ).run();
    purgeDatabase(db);
    const row = db.prepare('SELECT tool_requirements FROM tasks WHERE id = 1').get();
    expect(JSON.parse(row.tool_requirements)).toEqual(['laptop']);
  });

  it('does not touch a task with no junk at all', () => {
    db.prepare("INSERT INTO tasks (id, title, context_tags) VALUES (1, 'Clean task', '[\"home\"]')").run();
    const result = purgeDatabase(db);
    expect(result.tasksUpdated).toBe(0);
    const row = db.prepare('SELECT context_tags FROM tasks WHERE id = 1').get();
    expect(JSON.parse(row.context_tags)).toEqual(['home']);
  });

  it('is idempotent: a second run finds and changes nothing', () => {
    db.prepare(
      "INSERT INTO tasks (id, title, context_tags) VALUES (1, 'Mix track', '[\":mixing\",\"studio\"]')",
    ).run();
    purgeDatabase(db);
    const second = purgeDatabase(db);
    expect(second.tasksUpdated).toBe(0);
    expect(second.totalJunkEntries).toBe(0);
    const row = db.prepare('SELECT context_tags FROM tasks WHERE id = 1').get();
    expect(JSON.parse(row.context_tags)).toEqual(['studio']);
  });

  it('leaves malformed-JSON rows completely alone rather than guessing', () => {
    db.prepare("INSERT INTO tasks (id, title, context_tags) VALUES (1, 'Bad row', 'not json')").run();
    purgeDatabase(db);
    const row = db.prepare('SELECT context_tags FROM tasks WHERE id = 1').get();
    expect(row.context_tags).toBe('not json');
  });
});
