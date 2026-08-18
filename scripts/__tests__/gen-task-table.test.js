/**
 * Drift guard for the generated board.
 *
 * docs/master_task_table.md is the source of truth; docs/master_task_table.html
 * is generated from it by scripts/gen-task-table.js and must never be hand-edited.
 * The generator is a MANUAL step, so a commit that edits the markdown without
 * regenerating leaves the two files disagreeing — which is exactly the failure
 * this project keeps paying for (a stale HTML shipped in commit e7e3340,
 * 2026-08-18, and the four-day 35/36 "done but unmerged" episode is the same
 * shape: the record and the artifact out of sync).
 *
 * This test runs the generator's --check mode, which re-renders in memory and
 * compares to the committed HTML without writing. If they differ the committed
 * HTML is stale: run `node scripts/gen-task-table.js` and commit the result.
 */
const { execFileSync } = require('child_process');
const path = require('path');

const GEN = path.resolve(__dirname, '..', 'gen-task-table.js');

test('master_task_table.html is in sync with the markdown (run gen-task-table.js if this fails)', () => {
  expect(() => execFileSync('node', [GEN, '--check'], { stdio: 'pipe' })).not.toThrow();
});
