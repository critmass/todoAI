/**
 * Task 12 — Phase B on-device confirmation (S23 FE).
 * docs/briefs/opus_batch_B_device.md §"Task 12". THROWAWAY DEV SPIKE, NOT PRODUCTION.
 *
 * Task 6 and 7 only ever exercised llama.rn. THE DATA LAYER HAS NEVER RUN ON HARDWARE — src/db/
 * is "done" in the sense Tasks 6/7 were done before the device contradicted them twice. So step 1
 * is a deliberate de-risk spike (open → migrate → write → read) before anything is built on top.
 *
 *   1  DB spike       — open the real op-sqlite connection, run migrations, round-trip one row,
 *                       and settle tasks.ts's TODO(device verification) about the POWER() view.
 *   2  Triggers       — the three §7.2 triggers enqueue at the right urgency, against real SQLite.
 *   3  Real dispatch  — the real 4B emits a resolution union → dispatched through REAL repositories
 *                       → rows re-read and verified. Task 7 only proved this against fake deps.
 *   4  Completion     — the null-vs-unscheduled boundary, live (see the note on the button).
 *
 * Results log as chunked [T12RESULT:*] lines; capture with `adb logcat -s ReactNativeJS:*`.
 */

import React, { useCallback, useRef, useState } from 'react';
import { Button, ScrollView, StyleSheet, Text, View } from 'react-native';

import { buildGrammar } from '../llm/grammar/buildGrammar';
import { COACHING_RESOLUTION_V1_GBNF } from '../llm/grammar/grammarText';
import { assembleCoachingPrompt } from '../llm/prompts/assemble';
import { COACHING_RESOLUTION_FIELD_GUIDE } from '../llm/prompts/coaching';
import { TernaryBonsaiProvider } from '../llm/provider/ternaryBonsaiProvider';
import type { ChatMessage } from '../llm/provider';
import { enqueueCoachingTrigger, urgencyForTrigger } from '../services/coaching/triggers';
import { runCoachingResolution } from '../services/coaching/resolveCoaching';
import type { CoachingTrigger } from '../types/db';

const CONTEXT_TAGS_KNOWN = ['home', 'office', 'phone', 'computer'];

/**
 * The data layer is LAZY-LOADED, not statically imported. `src/db/connection.ts` imports
 * @op-engineering/op-sqlite at module top level, and that entrypoint throws the moment it is
 * evaluated without NativeModules.OPSQLite present — which is exactly what happens when
 * __tests__/App.test.tsx renders App under Jest. A static import here turns a dev screen into a
 * broken test suite (observed). Requiring inside the handler keeps the native module off App's
 * static graph and loads it only when a button is actually tapped on-device.
 */
type DbModule = typeof import('../db');
let dbModule: DbModule | null = null;
function db(): DbModule {
  if (!dbModule) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    dbModule = require('../db') as DbModule;
  }
  return dbModule;
}

function logResultJson(tag: string, value: unknown): void {
  const json = JSON.stringify(value);
  const CHUNK = 3000;
  const total = Math.max(1, Math.ceil(json.length / CHUNK));
  for (let i = 0; i < total; i++) {
    console.log(`[${tag} ${i + 1}/${total}] ${json.slice(i * CHUNK, (i + 1) * CHUNK)}`);
  }
}

export default function Task12DeviceScreen() {
  const [log, setLog] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const providerRef = useRef<TernaryBonsaiProvider | null>(null);
  const migratedRef = useRef(false);

  const append = useCallback((line: string) => {
    setLog((prev) => [...prev, line]);
    console.log('[T12]', line);
  }, []);

  const withRun = useCallback(
    (fn: () => Promise<void>) => async () => {
      setRunning(true);
      try {
        await fn();
      } catch (err: any) {
        append(`UNEXPECTED ERROR: ${String(err?.message ?? err)}`);
        console.log('[T12] stack', err?.stack);
      } finally {
        setRunning(false);
      }
    },
    [append],
  );

  const ensureDb = useCallback(async () => {
    if (migratedRef.current) return db().getRepositories();
    append('Opening op-sqlite connection ...');
    const conn = db().getConnection();
    append('Connection open. Running migrations ...');
    await db().runMigrations(conn);
    const version = await db().getCurrentSchemaVersion(conn);
    append(`Migrations done. schema version = ${version}`);
    migratedRef.current = true;
    return db().getRepositories();
  }, [append]);

  const ensureProvider = useCallback(async (): Promise<TernaryBonsaiProvider> => {
    if (providerRef.current?.isAvailable()) return providerRef.current;
    const provider = providerRef.current ?? new TernaryBonsaiProvider();
    providerRef.current = provider;
    append('Loading model ...');
    await provider.load();
    append('Model loaded.');
    return provider;
  }, [append]);

  // ---- 1: the DB de-risk spike ----
  const runDbSpike = withRun(async () => {
    const repos = await ensureDb();
    const conn = db().getConnection();

    // Round-trip a real row through the real repository.
    const created = await repos.tasks.create({
      title: 'DB spike task',
      estimatedDuration: 25,
      importance: 500,
      energyRequirement: 3,
    });
    append(`✓ created task id=${created.id} title="${created.title}"`);
    const read = await repos.tasks.getById(created.id);
    append(`✓ read back: ${read ? `id=${read.id} title="${read.title}" dur=${read.estimatedDuration}` : 'MISSING'}`);

    // FK pragma actually on? (connection.ts sets it per-connection — confirm on hardware.)
    const fk = await conn.execute('PRAGMA foreign_keys');
    append(`PRAGMA foreign_keys = ${JSON.stringify(fk.rows[0])}`);

    // listActiveByNeglect computes the multiplier in TS precisely because POWER() is expected to be
    // missing on this build (tasks.ts TODO(device verification)). Settle it here.
    const byNeglect = await repos.tasks.listActiveByNeglect();
    append(`✓ listActiveByNeglect returned ${byNeglect.length} row(s); first multiplier=${byNeglect[0]?.neglectMultiplier}`);

    let powerAvailable: boolean;
    let powerError: string | undefined;
    try {
      await conn.execute('SELECT POWER(2,2) AS p');
      powerAvailable = true;
      append('FINDING: POWER() IS available on this build — the view could be used directly (tasks.ts TODO).');
    } catch (err: any) {
      powerAvailable = false;
      powerError = String(err?.message ?? err);
      append(`✓ POWER() unavailable as predicted — the TS-side multiplier is required. (${powerError})`);
    }

    // Clean up the spike row so repeated runs don't pollute the pool.
    await repos.tasks.softDelete(created.id);
    append('✓ spike row soft-deleted');
    logResultJson('T12RESULT:dbSpike', {
      createdId: created.id,
      readBack: !!read,
      foreignKeys: fk.rows[0],
      neglectRows: byNeglect.length,
      powerAvailable,
      powerError,
    });
  });

  // ---- 2: the three triggers ----
  const runTriggers = withRun(async () => {
    const repos = await ensureDb();
    const task = await repos.tasks.create({ title: 'Trigger probe task', estimatedDuration: 30 });

    const cases: Array<{ trigger: CoachingTrigger; expected: string; why: string }> = [
      { trigger: 'task_skipped', expected: 'next_start', why: 'single skip → non-blocking follow-up' },
      { trigger: 'session_recalibration', expected: 'immediate', why: '3-in-session → stop and recalibrate now' },
      { trigger: 'app_reorientation', expected: 'next_open', why: '5+ days away → re-orient before dashboard' },
    ];
    const results: Array<Record<string, unknown>> = [];

    for (const c of cases) {
      const entry = await enqueueCoachingTrigger(repos.coaching, {
        trigger: c.trigger,
        triggerData: { probe: true },
        relatedTaskIds: [task.id],
      });
      const ok = entry.urgency === c.expected && urgencyForTrigger(c.trigger) === c.expected;
      append(`  ${ok ? '✓' : '✗'} ${c.trigger} → urgency=${entry.urgency} (expected ${c.expected}) — ${c.why}`);
      results.push({ trigger: c.trigger, urgency: entry.urgency, expected: c.expected, ok, id: entry.id });
    }

    // The queue is drained urgency-first — confirm the view orders on real SQLite.
    const queue = await repos.coaching.priorityQueue();
    append(`  priorityQueue (urgency-first) → [${queue.map((q) => `${q.triggerType}:${q.urgency}`).join(', ')}]`);
    logResultJson('T12RESULT:triggers', { results, queue: queue.map((q) => ({ t: q.triggerType, u: q.urgency })) });
    await repos.tasks.softDelete(task.id);
  });

  // ---- 3: real dispatch through real repositories ----
  const runRealDispatch = withRun(async () => {
    const repos = await ensureDb();
    const provider = await ensureProvider();

    const target = await repos.tasks.create({
      title: 'Clean out email inbox',
      estimatedDuration: 45,
      contextTags: ['computer'],
    });
    const decoy = await repos.tasks.create({ title: 'Organize garage', estimatedDuration: 120 });
    append(`seeded real rows: target=${target.id}, decoy=${decoy.id}`);

    const grammar = buildGrammar(COACHING_RESOLUTION_V1_GBNF, {
      task_id: [String(target.id), String(decoy.id)],
      depends_on_task_id: [String(target.id), String(decoy.id)],
      context_tags_known: CONTEXT_TAGS_KNOWN,
    });
    const conversation: ChatMessage[] = [
      { role: 'user', content: `Candidate tasks: ${target.id} = "Clean out email inbox" (45 min, computer). ${decoy.id} = "Organize garage" (120 min, home).` },
      { role: 'user', content: `I keep skipping task ${target.id}. 45 minutes of inbox feels like a wall — 15 minutes would be doable.` },
    ];

    append('running the real 4B → real dispatch → REAL repositories ...');
    const res = await runCoachingResolution({
      provider,
      messages: assembleCoachingPrompt({ base: COACHING_RESOLUTION_FIELD_GUIDE, conversation }),
      grammar,
      dispatch: { tasks: repos.tasks, dependencies: repos.dependencies },
      ctx: { todayISO: new Date().toISOString().slice(0, 10) },
      userText: conversation[1].content,
    });

    if (res.status !== 'dispatched') {
      append(`  ✗ status=${res.status} — no dispatch happened`);
      logResultJson('T12RESULT:realDispatch', { status: res.status });
      return;
    }
    append(`  ✓ dispatched (attempts=${res.attempts}): ${JSON.stringify(res.outcome)}`);

    // The point of "real dispatch": re-read the row and prove the effect actually persisted.
    const after = await repos.tasks.getById(target.id);
    append(`  row after dispatch: dur=${after?.estimatedDuration} tags=${JSON.stringify(after?.contextTags)} status=${after?.status}`);
    logResultJson('T12RESULT:realDispatch', {
      status: res.status,
      attempts: res.attempts,
      outcome: res.outcome,
      rowAfter: after,
    });

    await repos.tasks.softDelete(target.id);
    await repos.tasks.softDelete(decoy.id);
  });

  /**
   * 3b — dispatch scenarios that must MUTATE a row.
   *
   * Step 3 passed but proved less than it looks: the model chose break_down_task, which is a staged
   * stub (D8) — it calls requireTask and returns, leaving the row untouched. So step 3 exercised the
   * READ path only. These scenarios steer toward the mutating actions and then RE-READ the row to
   * prove the write actually landed in SQLite. Doubles as disposition quality at n>1.
   */
  const runDispatchScenarios = withRun(async () => {
    const repos = await ensureDb();
    const provider = await ensureProvider();

    const scenarios = [
      {
        label: 'modify',
        seed: { title: 'Clean out email inbox', estimatedDuration: 45 },
        say: (id: number) => `Task ${id} is set to 45 minutes and I bounce off it every time. Please change its duration to 15 minutes — that I could actually start.`,
        verify: (row: any) => ({ ok: row?.estimatedDuration === 15, saw: `dur=${row?.estimatedDuration}`, want: 'dur=15' }),
      },
      {
        label: 'eliminate',
        seed: { title: 'Book venue for the cancelled offsite', estimatedDuration: 30 },
        say: (id: number) => `Task ${id} doesn't need doing at all any more — the offsite was cancelled entirely. Get rid of it.`,
        verify: (row: any) => ({ ok: row?.status === 'deleted', saw: `status=${row?.status}`, want: 'status=deleted (soft-delete, NOT a completion)' }),
      },
      {
        label: 'defer',
        seed: { title: 'File the quarterly expenses', estimatedDuration: 40 },
        say: (id: number) => `I can't touch task ${id} until next Monday — nothing I can do before then. Push it out.`,
        verify: (row: any) => ({ ok: row?.nextDueAt != null, saw: `nextDueAt=${row?.nextDueAt}`, want: 'nextDueAt set' }),
      },
    ];

    const results: Array<Record<string, unknown>> = [];
    for (const s of scenarios) {
      const task = await repos.tasks.create(s.seed);
      const grammar = buildGrammar(COACHING_RESOLUTION_V1_GBNF, {
        task_id: [String(task.id)],
        depends_on_task_id: [String(task.id)],
        context_tags_known: CONTEXT_TAGS_KNOWN,
      });
      const userText = s.say(task.id);
      const conversation: ChatMessage[] = [
        { role: 'user', content: `Candidate tasks: ${task.id} = "${task.title}" (${task.estimatedDuration} min).` },
        { role: 'user', content: userText },
      ];
      const res = await runCoachingResolution({
        provider,
        messages: assembleCoachingPrompt({ base: COACHING_RESOLUTION_FIELD_GUIDE, conversation }),
        grammar,
        dispatch: { tasks: repos.tasks, dependencies: repos.dependencies },
        ctx: { todayISO: new Date().toISOString().slice(0, 10) },
        userText,
      });

      if (res.status !== 'dispatched') {
        append(`  ✗ [${s.label}] status=${res.status}`);
        results.push({ label: s.label, status: res.status });
        continue;
      }
      const row = await repos.tasks.getById(task.id);
      const v = s.verify(row);
      append(`  ${v.ok ? '✓' : '✗'} [${s.label}] action=${res.outcome.action} → ${v.saw} (want ${v.want})`);
      results.push({ label: s.label, action: res.outcome.action, outcome: res.outcome, rowAfter: row, verified: v.ok });
      await repos.tasks.softDelete(task.id);
    }
    logResultJson('T12RESULT:dispatchScenarios', { results });
    append('[scenarios] a PASS needs the ROW to change — a staged stub leaving it untouched proves only the read path.');
  });

  // ---- 4: the completion-primitive boundary (null vs unscheduled) ----
  // NOTE: no coaching_resolution action COMPLETES a task (dispatch.ts is explicit: eliminate_task
  // is a soft-delete, deliberately NOT a completion), so this boundary is NOT reachable through
  // resolution dispatch. It lives on the repositories, and this probe exercises it directly —
  // the brief's "right completion primitive per recurrence type" aimed at the wrong module.
  const runCompletionBoundary = withRun(async () => {
    const repos = await ensureDb();

    const oneOff = await repos.tasks.create({ title: 'Renew passport (one-off)', estimatedDuration: 60 });
    const ongoing = await repos.tasks.create({ title: 'Work on novel (unscheduled)', estimatedDuration: 60 });
    await repos.recurrence.create(ongoing.id, { type: 'unscheduled' });

    // One-off: completing CLOSES it.
    await repos.tasks.update(oneOff.id, { status: 'completed' });
    const oneOffAfter = await repos.tasks.getById(oneOff.id);

    // Unscheduled: completing resets the neglect clock but the task STAYS ACTIVE.
    await repos.tasks.recordUnscheduledCompletion(ongoing.id);
    const ongoingAfter = await repos.tasks.getById(ongoing.id);

    const oneOffOk = oneOffAfter?.status === 'completed';
    const ongoingOk = ongoingAfter?.status === 'active';
    append(`  ${oneOffOk ? '✓' : '✗'} one-off after completion: status=${oneOffAfter?.status} (expect completed — it closes)`);
    append(`  ${ongoingOk ? '✓' : '✗'} unscheduled after completion: status=${ongoingAfter?.status} lastCompleted=${ongoingAfter?.lastCompletedAt} (expect active — clock resets, stays in the pool)`);
    logResultJson('T12RESULT:completionBoundary', {
      oneOff: { status: oneOffAfter?.status, ok: oneOffOk },
      unscheduled: { status: ongoingAfter?.status, lastCompletedAt: ongoingAfter?.lastCompletedAt, ok: ongoingOk },
    });

    await repos.tasks.softDelete(oneOff.id);
    await repos.tasks.softDelete(ongoing.id);
  });

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ paddingBottom: 32 }}>
      <Text style={styles.title}>Task 12 — Device Confirmation (S23 FE)</Text>
      <Text style={styles.note}>src/db/ has never run on hardware. Run the spike first.</Text>
      <Button title="1 · DB spike (open/migrate/round-trip)" onPress={runDbSpike} disabled={running} />
      <View style={styles.gap} />
      <Button title="2 · Three triggers → urgency" onPress={runTriggers} disabled={running} />
      <View style={styles.gap} />
      <Button title="3 · Real dispatch through real repos" onPress={runRealDispatch} disabled={running} />
      <View style={styles.gap} />
      <Button title="3b · Mutating scenarios (modify/eliminate/defer)" onPress={runDispatchScenarios} disabled={running} />
      <View style={styles.gap} />
      <Button title="4 · Completion boundary (null vs unscheduled)" onPress={runCompletionBoundary} disabled={running} />
      <View style={styles.gap} />
      {log.map((line, i) => (
        <Text key={i} style={styles.logLine}>{line}</Text>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16 },
  title: { fontSize: 16, fontWeight: '600', marginBottom: 4 },
  note: { fontSize: 11, marginBottom: 12, opacity: 0.7 },
  gap: { height: 8 },
  logLine: { fontFamily: 'monospace', fontSize: 11, marginBottom: 2 },
});
