// Splits a multi-statement SQL script into individual statements for drivers (op-sqlite) that
// only execute one statement per call. A naive split on ';' breaks this schema's triggers -
// CREATE TRIGGER ... BEGIN ... END; bodies contain their own internal ';' terminators - so this
// tracks BEGIN/END nesting depth (and skips ';' inside string literals and comments) and only
// splits at top-level statement boundaries.
const BEGIN_WORD = /^BEGIN\b/i;
const END_WORD = /^END\b/i;

export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let depth = 0;
  let inSingleQuote = false;
  let i = 0;
  const n = sql.length;

  while (i < n) {
    const ch = sql[i];

    if (!inSingleQuote && ch === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i);
      const end = nl === -1 ? n : nl + 1;
      current += sql.slice(i, end);
      i = end;
      continue;
    }

    if (!inSingleQuote && ch === '/' && sql[i + 1] === '*') {
      const close = sql.indexOf('*/', i + 2);
      const end = close === -1 ? n : close + 2;
      current += sql.slice(i, end);
      i = end;
      continue;
    }

    if (ch === "'") {
      inSingleQuote = !inSingleQuote;
      current += ch;
      i++;
      continue;
    }

    if (!inSingleQuote) {
      const rest = sql.slice(i);
      const beginMatch = rest.match(BEGIN_WORD);
      if (beginMatch) {
        depth++;
        current += beginMatch[0];
        i += beginMatch[0].length;
        continue;
      }
      const endMatch = rest.match(END_WORD);
      if (endMatch) {
        depth = Math.max(0, depth - 1);
        current += endMatch[0];
        i += endMatch[0].length;
        continue;
      }
      if (ch === ';' && depth === 0) {
        const trimmed = current.trim();
        if (trimmed.length > 0) statements.push(trimmed);
        current = '';
        i++;
        continue;
      }
    }

    current += ch;
    i++;
  }

  const trimmed = current.trim();
  if (trimmed.length > 0) statements.push(trimmed);
  return statements;
}
