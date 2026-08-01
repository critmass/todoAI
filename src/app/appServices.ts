// Task 24 — one place where the app's dependency graph is assembled, so every controller is
// constructed from explicit repositories rather than reaching for a module singleton. This is the
// only file in `src/app/` that touches the native SQLite entry point; everything above it takes
// its repositories as arguments and is therefore testable against a better-sqlite3 double.

import { getConnection, getCurrentSchemaVersion, getRepositories, runMigrations, type Repositories } from '../db';
import type { EpisodeServiceDeps } from '../execution';
import type { PlanningRepositories } from '../planning/service';
import type { RecurrenceSweepDeps } from '../services/recurrence';
import { createEpisodeAlarm, type EpisodeAlarm } from './alarm/episodeExpiryScheduler';

export interface AppServices {
  repos: Repositories;
  /** Task 13's dependency bundle, with the real expiry alarm wired into its scheduler seam. */
  episode: EpisodeServiceDeps;
  /** Task 11's three planning reads. */
  planning: PlanningRepositories;
  /** Task 36's two repositories: the period sweep runs at app open and at session start. */
  recurrence: RecurrenceSweepDeps;
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
  return {
    repos,
    episode: episodeDepsFrom(repos, alarm),
    planning: planningDepsFrom(repos),
    recurrence: recurrenceDepsFrom(repos),
    alarm,
    schemaVersion: (await getCurrentSchemaVersion(connection)) ?? 'unknown',
  };
}
