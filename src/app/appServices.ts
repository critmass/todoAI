// Task 24 — one place where the app's dependency graph is assembled, so every controller is
// constructed from explicit repositories rather than reaching for a module singleton. This is the
// only file in `src/app/` that touches the native SQLite entry point; everything above it takes
// its repositories as arguments and is therefore testable against a better-sqlite3 double.
//
// TASK 41 ALSO MAKES THIS THE ATTRIBUTION POINT FOR THE `mutation` STREAM. The actor of a task
// write is a fact about WHICH BUNDLE the repository was handed to, and that knowledge already
// lives here — so the repository set is wrapped per consumer rather than an actor being threaded
// through every call (design §5.5). Removing the mutation stream is deleting
// `src/capture/streams/mutationCapture.ts` and unwrapping the five expressions below.

import { getConnection, getCurrentSchemaVersion, getRepositories, runMigrations, type Repositories } from '../db';
import { withMutationCapture } from '../capture';
import type { EpisodeServiceDeps } from '../execution';
import type { PlanningRepositories } from '../planning/service';
import type { RecurrenceSweepDeps } from '../services/recurrence';
import type { ResolutionDispatchDeps } from '../services/coaching/dispatch';
import { createEpisodeAlarm, type EpisodeAlarm } from './alarm/episodeExpiryScheduler';

export interface AppServices {
  repos: Repositories;
  /** Task 13's dependency bundle, with the real expiry alarm wired into its scheduler seam. */
  episode: EpisodeServiceDeps;
  /** Task 11's three planning reads. */
  planning: PlanningRepositories;
  /** Task 36's two repositories: the period sweep runs at app open and at session start. */
  recurrence: RecurrenceSweepDeps;
  /** Task 41 attribution bundles — see `withMutationCapture` below. */
  chatTasks: Repositories['tasks'];
  chatRecurrence: Repositories['recurrence'];
  chatDispatch: ResolutionDispatchDeps;
  editor: Repositories;
  alarm: EpisodeAlarm;
  schemaVersion: string;
}

/** Builds the episode-service deps from a repository set. Exported so tests can assemble the
 *  same bundle over a test connection without going near the native module. */
export function episodeDepsFrom(
  repos: Repositories,
  alarm: EpisodeServiceDeps['scheduler'],
): EpisodeServiceDeps {
  return {
    tasks: repos.tasks,
    recurrence: repos.recurrence,
    interactions: repos.interactions,
    sessions: repos.sessions,
    coaching: repos.coaching,
    runtime: repos.runtime,
    scheduler: alarm,
  };
}

export function planningDepsFrom(repos: Repositories): PlanningRepositories {
  return { tasks: repos.tasks, dependencies: repos.dependencies, coaching: repos.coaching };
}

export function recurrenceDepsFrom(repos: Repositories): RecurrenceSweepDeps {
  return { tasks: repos.tasks, recurrence: repos.recurrence };
}

/**
 * Opens the database, applies migrations and wires everything. Runs once, before the launch
 * sequence — which then runs `recoverOpenEpisode` as its very first act, because until the
 * migrations have applied there is no `active_episode` table to read.
 */
export async function initAppServices(): Promise<AppServices> {
  const connection = getConnection();
  await runMigrations(connection);
  const repos = getRepositories();
  const alarm = createEpisodeAlarm();

  // ── TASK 41: mutation attribution, per amendment §3's ruled actor vocabulary ────────────────
  //
  // `user`    the editor; direct task creation
  // `coach`   chat extraction; coaching-resolution dispatch
  // `system`  the recurrence sweep; the completion fold; episode-close writes
  // `planner` catch-all SENTINEL, expected count ZERO — never named here, only reached by a bundle
  //           that was wired without an attribution. Its emptiness is its value.
  //
  // Chat-created tasks are `coach`, not `user`: the user asked for the task, but the FIELD VALUES
  // being measured — duration, energy, recurrence, tags — were chosen by the model. Attributing
  // them to the user would credit the model's guesses to the user, which is the same error shape as
  // the quick-start confounder. Ruled by Jason 2026-08-17.
  const systemEpisodeRepos = withMutationCapture(repos, 'system', 'episode_close');
  const systemRecurrenceRepos = withMutationCapture(repos, 'system', 'recurrence_sweep');
  const coachExtractionRepos = withMutationCapture(repos, 'coach', 'chat_extraction');
  const coachDispatchRepos = withMutationCapture(repos, 'coach', 'coaching_dispatch');
  const editorRepos = withMutationCapture(repos, 'user', 'editor');

  return {
    repos,
    // The completion fold (`taskCompletion.completeTask`) runs through the episode bundle's
    // `tasks`, so `completion_fold` writes are covered by `episode_close` rather than needing a
    // sixth wrapper — the surface names the seam that invoked it, which is the truthful reading.
    episode: episodeDepsFrom(systemEpisodeRepos, alarm),
    // Planning is READ-ONLY (it makes no writes at all — orientation §5: deterministic v1), so it
    // is deliberately NOT wrapped. Wrapping it would produce nothing but confusion about whether
    // the planner mutates.
    planning: planningDepsFrom(repos),
    recurrence: recurrenceDepsFrom(systemRecurrenceRepos),
    chatTasks: coachExtractionRepos.tasks,
    chatRecurrence: coachExtractionRepos.recurrence,
    chatDispatch: {
      tasks: coachDispatchRepos.tasks,
      dependencies: coachDispatchRepos.dependencies,
    },
    editor: editorRepos,
    alarm,
    schemaVersion: (await getCurrentSchemaVersion(connection)) ?? 'unknown',
  };
}
