/**
 * Task 13 — Phase B on-device harness (S23 FE).
 * docs/briefs/timer_crash_recovery_task_13.md §5. THROWAWAY DEV SPIKE, NOT PRODUCTION.
 *
 * Phase A built the whole timer engine and episode lifecycle against an INJECTED clock and a
 * better-sqlite3 double. Everything it proves is true of the arithmetic and false of the phone:
 * crash, background, process-kill and doze behavior are only observable here. So is migration 005
 * and op-sqlite against the three new runtime tables, which have never run on hardware.
 *
 * WHY THIS SCREEN EXISTS: task 24 does not exist yet, so nothing renders an episode. This is the
 * minimum surface that can drive the engine hard enough to test it — no microcopy, no design, no
 * claim to be the execution screen.
 *
 * THE ONE THAT MATTERS (brief §1.3). On mount this reads the surviving `active_episode` row and
 * shows it WITHOUT recovering, so a force-kill can be inspected before it is resolved. Production
 * runs recoverOpenEpisode() automatically at launch; here it is a button, so the tester can see
 * the crash signal, run recovery, and then check the three things a crash must never produce:
 * no skip_count, no coaching row, and a task still active with its time credited.
 *
 * Force-kill from the host, mid-episode:
 *     adb shell am force-stop com.todoai
 * Background / return:
 *     adb shell input keyevent KEYCODE_HOME    (then relaunch from the launcher)
 * Doze:
 *     adb shell dumpsys deviceidle force-idle
 *
 * Results log as [T13] lines; capture with `adb logcat -s ReactNativeJS:*`.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Button, ScrollView, StyleSheet, Text, View } from 'react-native';

import {
  applyHyperfocusExtension,
  applyShortExtension,
  checkSessionLapse,
  closeSession,
  completeEpisode,
  currentTimer,
  endOfBlockPrompt,
  escapeToEasier,
  parkEpisode,
  pauseEpisode,
  recoverOpenEpisode,
  resumeEpisode,
  skipEpisode,
  startEpisode,
  startSessionRuntime,
  type EpisodeExpiryScheduler,
  type EpisodeServiceDeps,
} from '../execution';
import type { AgendaTaskItem } from '../planning/agenda';
import type { ActiveEpisode, Task } from '../types/domain';

const SESSION_ID = 't13-device-session';
/** Short on purpose: a 25-minute block is untestable by hand. The arithmetic is scale-free (Phase
 *  A proves that); what this screen is for is the process/OS behavior around it. */
const BLOCK_MINUTES = 2;
const SESSION_MINUTES = 10;

/**
 * The data layer is LAZY-LOADED, not statically imported — same reason as Task12DeviceScreen:
 * src/db/connection.ts imports @op-engineering/op-sqlite at module top level and that entrypoint
 * throws the moment it is evaluated without NativeModules.OPSQLite present, which is exactly what
 * happens when __tests__/App.test.tsx renders App under Jest. src/execution/ above is safe to
 * import statically: it is pure TypeScript over repository TYPES, with no native module on its
 * static graph.
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

function fmt(ms: number): string {
  const sign = ms < 0 ? '-' : '';
  const total = Math.floor(Math.abs(ms) / 1000);
  return `${sign}${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

export default function Task13DeviceScreen() {
  const [log, setLog] = useState<string[]>([]);
  const [ready, setReady] = useState(false);
  const [survivor, setSurvivor] = useState<ActiveEpisode | null | 'none'>(null);
  const [tick, setTick] = useState<string>('—');
  const [alarm, setAlarm] = useState<string | null>(null);
  const depsRef = useRef<EpisodeServiceDeps | null>(null);
  const taskRef = useRef<Task | null>(null);
  const alarmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const append = useCallback((line: string) => {
    setLog((prev) => [...prev.slice(-120), line]);
    console.log('[T13]', line);
  }, []);

  /** The alarm hook, stable across renders. A setTimeout is NOT a real alarm and is not meant to
   *  be — task 24 owns the platform call. What this proves is that the engine asks for the right
   *  instant, and (the part only the device can answer) whether a JS timer survives backgrounding
   *  and doze at all. If it does not, that is a finding, not a bug in this screen. */
  const schedulerRef = useRef<EpisodeExpiryScheduler>({
    schedule(atMs: number) {
      if (alarmTimer.current) clearTimeout(alarmTimer.current);
      const delay = Math.max(0, atMs - Date.now());
      append(`scheduler.schedule(+${Math.round(delay / 1000)}s)`);
      alarmTimer.current = setTimeout(() => {
        setAlarm(`BLOCK EXPIRED at ${new Date().toISOString().slice(11, 19)}`);
        append('*** ALARM FIRED (block end reached) ***');
      }, delay);
    },
    cancel() {
      if (alarmTimer.current) clearTimeout(alarmTimer.current);
      alarmTimer.current = null;
      setAlarm(null);
    },
  });

  const boot = useCallback(async () => {
    append('Opening op-sqlite connection ...');
    const conn = db().getConnection();
    await db().runMigrations(conn);
    const version = await db().getCurrentSchemaVersion(conn);
    append(`Migrations applied. schema version = ${version} (expect 2.6.0 — migration 005)`);

    const repos = db().getRepositories();
    depsRef.current = { ...repos, scheduler: schedulerRef.current };

    // THE CRASH SIGNAL, read before anything resolves it.
    const open = await repos.runtime.getActiveEpisode();
    setSurvivor(open ?? 'none');
    if (open) {
      append(`SURVIVING OPEN EPISODE FOUND — task ${open.taskId}, started ${new Date(open.startedAtMs).toISOString()}`);
      append('This row outliving the process IS the crash signal. Tap "Run recovery".');
    } else {
      append('No open episode — clean launch.');
    }
    setReady(true);
  }, [append]);

  useEffect(() => {
    boot().catch((err: any) => append(`BOOT FAILED: ${String(err?.message ?? err)}`));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live timer readout. The ENGINE never reads a clock; the app does, and passes it in.
  useEffect(() => {
    const id = setInterval(() => {
      const deps = depsRef.current;
      if (!deps) return;
      currentTimer(deps, Date.now())
        .then((snap) => {
          setTick(
            snap == null
              ? 'no open episode'
              : `${snap.face} rem ${fmt(snap.remainingMs)} · worked ${fmt(snap.workedMs)} · ` +
                `${snap.paused ? 'PAUSED' : 'running'}${snap.boundaryReached ? ' · BOUNDARY' : ''}` +
                `${snap.parkAvailable ? ' · park ok' : ' · park gated'}`,
          );
        })
        .catch(() => undefined);
    }, 1000);
    return () => clearInterval(id);
  }, []);

  const run = useCallback(
    (label: string, fn: (deps: EpisodeServiceDeps) => Promise<unknown>) => async () => {
      const deps = depsRef.current;
      if (!deps) return append('not ready');
      try {
        const out = await fn(deps);
        append(`${label} → ${JSON.stringify(out)}`);
      } catch (err: any) {
        append(`${label} THREW: ${String(err?.name ?? '')}: ${String(err?.message ?? err)}`);
      }
    },
    [append],
  );

  const startAll = run('startSession+episode', async (deps) => {
    const repos = db().getRepositories();
    const existing = await repos.sessions.getById(SESSION_ID);
    if (!existing) {
      // Born 'abandoned': sessions.status has no in-progress value, so a crash leaves the
      // truthful status behind and closeSession overwrites it on a clean end.
      await repos.sessions.create(SESSION_ID, {
        sessionType: 'deep_focus',
        plannedDuration: SESSION_MINUTES,
        status: 'abandoned',
      });
    }
    const now = Date.now();
    await startSessionRuntime(deps, {
      sessionId: SESSION_ID,
      startedAtMs: now,
      plannedMinutes: SESSION_MINUTES,
    });
    const task =
      taskRef.current ??
      (await repos.tasks.create({ title: 'Device timer task', estimatedDuration: 30 }));
    taskRef.current = task;
    const item: AgendaTaskItem = {
      kind: 'task',
      task,
      blockKind: 'countdown',
      plannedMinutes: BLOCK_MINUTES,
      deepFocus: false,
      resumeClaim: false,
    };
    const episode = await startEpisode(deps, { sessionId: SESSION_ID, item, now });
    return { taskId: task.id, blockEndAt: new Date(episode.blockEndAtMs).toISOString() };
  });

  const dumpState = run('dumpState', async (deps) => {
    const episode = await deps.runtime.getActiveEpisode();
    const task = episode
      ? await deps.tasks.getById(episode.taskId)
      : taskRef.current
        ? await deps.tasks.getById(taskRef.current.id)
        : undefined;
    const session = await deps.sessions.getById(SESSION_ID);
    const queue = await deps.coaching.priorityQueue();
    return {
      openEpisode: episode ?? null,
      sessionRuntime: (await deps.runtime.getSessionRuntime(SESSION_ID)) ?? null,
      task: task && {
        id: task.id,
        workState: task.workState,
        accumulatedMinutes: task.accumulatedMinutes,
        skipCount: task.skipCount,
        status: task.status,
        history: task.actualDurationHistory,
      },
      session: session && {
        status: session.status,
        completed: session.tasksCompleted,
        skipped: session.tasksSkipped,
        progressed: session.tasksProgressed,
        extended: session.extended,
      },
      coaching: queue.map((q) => ({ t: q.triggerType, kind: q.triggerData?.kind, u: q.urgency })),
    };
  });

  const recover = run('recoverOpenEpisode', async (deps) => {
    const result = await recoverOpenEpisode(deps, Date.now());
    setSurvivor('none');
    return result;
  });

  const wipe = run('wipe', async (deps) => {
    await closeSession(deps, { sessionId: SESSION_ID, now: Date.now(), status: 'completed' });
    taskRef.current = null;
    setAlarm(null);
    return 'runtime cleared';
  });

  return (
    <ScrollView contentContainerStyle={styles.body}>
      <Text style={styles.h1}>Task 13 — timer / episode / crash recovery</Text>
      <Text style={styles.mono}>{ready ? tick : 'booting ...'}</Text>
      {alarm != null && <Text style={styles.alarm}>{alarm}</Text>}
      {survivor !== null && survivor !== 'none' && (
        <Text style={styles.crash}>
          CRASH SIGNAL: open episode on task {survivor.taskId}, block end{' '}
          {new Date(survivor.blockEndAtMs).toISOString().slice(11, 19)} — inspect, then recover.
        </Text>
      )}

      <Text style={styles.h2}>Lifecycle</Text>
      <View style={styles.row}>
        <Button title="Start" onPress={startAll} />
        <Button title="Pause" onPress={run('pause', (d) => pauseEpisode(d, Date.now()))} />
        <Button title="Resume" onPress={run('resume', (d) => resumeEpisode(d, Date.now()))} />
      </View>

      <Text style={styles.h2}>Prompt + the two extension paths</Text>
      <View style={styles.row}>
        <Button title="Prompt?" onPress={run('endOfBlockPrompt', (d) => endOfBlockPrompt(d, Date.now()))} />
        <Button title="+5" onPress={run('applyShortExtension', (d) => applyShortExtension(d))} />
        <Button title="Keep going" onPress={run('applyHyperfocus', (d) => applyHyperfocusExtension(d))} />
      </View>

      <Text style={styles.h2}>Outcomes</Text>
      <View style={styles.row}>
        <Button title="Done" onPress={run('complete', (d) => completeEpisode(d, Date.now()))} />
        <Button title="Park" onPress={run('park', (d) => parkEpisode(d, Date.now()))} />
        <Button title="Skip" onPress={run('skip', (d) => skipEpisode(d, Date.now()))} />
        <Button title="Easier" onPress={run('escapeToEasier', (d) => escapeToEasier(d, Date.now()))} />
      </View>

      <Text style={styles.h2}>Recovery + inspection</Text>
      <View style={styles.row}>
        <Button title="Run recovery" onPress={recover} />
        <Button title="Dump state" onPress={dumpState} />
        <Button
          title="Lapse?"
          onPress={run('checkSessionLapse', (d) =>
            checkSessionLapse(d, { sessionId: SESSION_ID, now: Date.now() }),
          )}
        />
        <Button title="Wipe" onPress={wipe} />
      </View>

      <Text style={styles.h2}>Log</Text>
      {log.map((line, i) => (
        <Text key={i} style={styles.logLine}>
          {line}
        </Text>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  body: { padding: 12, paddingBottom: 48 },
  h1: { fontSize: 16, fontWeight: 'bold', marginBottom: 6 },
  h2: { fontSize: 13, fontWeight: 'bold', marginTop: 14, marginBottom: 4 },
  mono: { fontFamily: 'monospace', fontSize: 14 },
  alarm: { fontWeight: 'bold', marginTop: 6 },
  crash: { fontWeight: 'bold', marginTop: 6 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  logLine: { fontFamily: 'monospace', fontSize: 10, marginTop: 1 },
});
