// Task 24 — the product app: the launch sequence, the router, and the wiring between the
// controllers and the screens. There is no navigation library and no global store; the app has
// seven destinations and three controllers, and a discriminated union plus `useSyncExternalStore`
// says that more clearly than a router would.
//
// THE ONE TIMER IN THIS FILE IS A DISPLAY REFRESH, NOT THE ALARM. `useTimerSnapshot` re-READS the
// engine's stored end-time once a second so the digits on screen change; it accumulates nothing,
// and if it never fired the state would still be exactly right on the next render. The thing that
// has to fire while the app is asleep is the AlarmManager alarm (constraint #13, ./alarm) — never
// a JS timer, which task 13 measured arriving 38–45 s late from doze.

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  ActivityIndicator,
  AppState,
  BackHandler,
  StatusBar,
  StyleSheet,
  View,
} from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { colors, spacing } from './theme';
import { Body, Caption, Display, Screen } from './components';
import { initAppServices, type AppServices } from './appServices';
import { pendingAtSessionStart, runLaunchSequence } from './launch';
import {
  createSessionController,
  formatClock,
  type SessionController,
} from './session/sessionController';
import { DURATION_CHOICES, type SessionPhase, type UserEnergy } from './session/types';
import { createChatController, type ChatController, type ChatPurpose } from './chat/chatController';
import { createModelHost } from './chat/modelHost';
import {
  createTaskLibraryController,
  type TaskLibraryController,
} from './tasks/taskLibraryController';
import { ensureNotificationPermission } from './alarm/episodeExpiryScheduler';
import type { TimerSnapshot } from '../execution';
import type { SessionPerformanceStats } from '../types/domain';

import DashboardScreen from './screens/DashboardScreen';
import TaskListScreen from './screens/TaskListScreen';
import TaskEditorScreen from './screens/TaskEditorScreen';
import ChatScreen from './screens/ChatScreen';
import MetricsScreen from './screens/MetricsScreen';
import SettingsScreen from './screens/SettingsScreen';
import CheckInEnergyScreen from './screens/CheckInEnergyScreen';
import CheckInDurationScreen from './screens/CheckInDurationScreen';
import CheckInContextScreen from './screens/CheckInContextScreen';
import ToolsCheckScreen from './screens/ToolsCheckScreen';
import WorkScreen from './screens/WorkScreen';
import EndOfBlockScreen from './screens/EndOfBlockScreen';
import BreakScreen from './screens/BreakScreen';
import RecoveredScreen from './screens/RecoveredScreen';
import PlanEmptyScreen from './screens/PlanEmptyScreen';
import SessionSummaryScreen from './screens/SessionSummaryScreen';

type Route =
  | { kind: 'dashboard' }
  | { kind: 'taskList' }
  | { kind: 'taskEditor' }
  | { kind: 'chat' }
  /** The whole session flow. Which screen shows is the controller's `phase`, not a second route —
   *  two sources of navigation truth is how a flow like this drifts out of sync with its state. */
  | { kind: 'session' }
  | { kind: 'metrics' }
  | { kind: 'settings' };

interface Controllers {
  services: AppServices;
  session: SessionController;
  chat: ChatController;
  library: TaskLibraryController;
}

/**
 * Starts work that the UI does not wait on, with the rejection actually handled. Every controller
 * already surfaces its own failures onto its state (see each one's `guard`), so this is the last
 * line of defence rather than the error path — but a swallowed rejection is how a screen ends up
 * silently stuck, and there is no cost to catching it.
 */
function fire(work: Promise<unknown>): void {
  work.catch((err) => {
    console.warn('[todoAI] background work failed:', err);
  });
}

/** Subscribes a component to a controller's store. */
function useControllerState<S>(controller: {
  getState: () => S;
  subscribe: (listener: (state: S) => void) => () => void;
}): S {
  return useSyncExternalStore(
    useCallback((onChange: () => void) => controller.subscribe(onChange), [controller]),
    useCallback(() => controller.getState(), [controller]),
  );
}

/**
 * The timer face, refreshed once a second from the ENGINE's stored end-time. Nothing is counted
 * here and nothing is accumulated: each tick is a fresh read, so a tick that never happens (the
 * app was backgrounded, the JS thread was suspended) costs nothing but a stale digit that
 * corrects itself the moment the screen renders again.
 */
function useTimerSnapshot(session: SessionController, live: boolean): TimerSnapshot | null {
  const [snapshot, setSnapshot] = useState<TimerSnapshot | null>(null);
  useEffect(() => {
    if (!live) {
      setSnapshot(null);
      return;
    }
    let alive = true;
    const read = () =>
      fire(
        session.readTimer().then((next) => {
          if (alive) setSnapshot(next);
        }),
      );
    read();
    const id = setInterval(read, 1000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [session, live]);
  return snapshot;
}

export default function App() {
  return (
    <SafeAreaProvider>
      <StatusBar barStyle="dark-content" backgroundColor={colors.surface} />
      <AppRoot />
    </SafeAreaProvider>
  );
}

function AppRoot() {
  const [controllers, setControllers] = useState<Controllers | null>(null);
  const [route, setRoute] = useState<Route>({ kind: 'dashboard' });
  const [bootError, setBootError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    async function boot(): Promise<void> {
      const services = await initAppServices();
      const now = () => Date.now();
      const session = createSessionController({
        episode: services.episode,
        planning: services.planning,
        catalog: services.repos.tasks,
        sessions: services.repos.sessions,
        now,
      });
      const chat = createChatController({
        model: createModelHost(),
        tasks: services.repos.tasks,
        recurrence: services.repos.recurrence,
        coaching: services.repos.coaching,
        dispatch: { tasks: services.repos.tasks, dependencies: services.repos.dependencies },
        now,
      });
      const library = createTaskLibraryController({
        tasks: services.repos.tasks,
        recurrence: services.repos.recurrence,
        dependencies: services.repos.dependencies,
      });

      // Crash recovery FIRST, before any screen is chosen (see ./launch.ts).
      const outcome = await runLaunchSequence({
        episode: services.episode,
        coaching: services.repos.coaching,
        now,
      });

      setControllers({ services, session, chat, library });

      if (outcome.kind === 'recovered') {
        await session.adoptRecoveredSession({
          sessionId: outcome.sessionId,
          directive: outcome.directive,
          creditedMinutes: outcome.creditedMinutes,
        });
        setRoute({ kind: 'session' });
      } else if (outcome.kind === 'coaching') {
        chat.open({
          kind: 'coaching',
          trigger: outcome.entry.triggerType,
          queueEntryId: outcome.entry.id,
          candidateTaskIds: outcome.entry.relatedTaskIds,
        });
        setRoute({ kind: 'chat' });
      } else {
        setRoute({ kind: 'dashboard' });
      }

      // Asked at launch, never mid-session: a permission dialog on top of a running block is
      // exactly the interruption the alarm exists to avoid causing.
      fire(ensureNotificationPermission());
    }

    boot().catch((err) => setBootError(err instanceof Error ? err.message : String(err)));
  }, []);

  if (bootError) return <BootFailed message={bootError} />;
  if (!controllers) return <Booting />;
  return <Router controllers={controllers} route={route} setRoute={setRoute} />;
}

function Booting() {
  return (
    <Screen>
      <View style={styles.centre}>
        <ActivityIndicator color={colors.primary} size="large" />
        <Caption>Getting things ready…</Caption>
      </View>
    </Screen>
  );
}

function BootFailed({ message }: { message: string }) {
  return (
    <Screen>
      <View style={styles.centre}>
        <Display>Something went wrong opening your data</Display>
        <Body>{message}</Body>
        <Caption>Nothing has been lost — close the app and open it again.</Caption>
      </View>
    </Screen>
  );
}

function Router({
  controllers,
  route,
  setRoute,
}: {
  controllers: Controllers;
  route: Route;
  setRoute: (route: Route) => void;
}) {
  const { services, session, chat, library } = controllers;
  const libraryState = useControllerState(library);
  const chatState = useControllerState(chat);
  const [notificationsGranted, setNotificationsGranted] = useState(true);
  const [metrics, setMetrics] = useState<{
    active: number;
    inProgress: number;
    performance: SessionPerformanceStats[];
  }>({ active: 0, inProgress: 0, performance: [] });

  const toDashboard = useCallback(() => setRoute({ kind: 'dashboard' }), [setRoute]);

  // Keeps the dashboard's empty state honest without re-reading on every render.
  useEffect(() => {
    if (route.kind === 'dashboard') fire(library.refresh());
  }, [route.kind, library]);

  const openChat = useCallback(
    (purpose: ChatPurpose) => {
      chat.open(purpose);
      setRoute({ kind: 'chat' });
    },
    [chat, setRoute],
  );

  const startWork = useCallback(async () => {
    // Coaching queued for "the next time you start working" belongs at this seam, not at app
    // open — that is what the urgency tier means (spec §7.2).
    const waiting = pendingAtSessionStart(await services.repos.coaching.priorityQueue());
    if (waiting) {
      openChat({
        kind: 'coaching',
        trigger: waiting.triggerType,
        queueEntryId: waiting.id,
        candidateTaskIds: waiting.relatedTaskIds,
      });
      return;
    }
    await session.begin();
    setRoute({ kind: 'session' });
  }, [services, session, openChat, setRoute]);

  const openMetrics = useCallback(async () => {
    const active = await services.repos.tasks.listActive();
    setMetrics({
      active: active.length,
      inProgress: active.filter((task) => task.workState === 'in_progress').length,
      performance: await services.repos.sessions.recentPerformance(),
    });
    setRoute({ kind: 'metrics' });
  }, [services, setRoute]);

  const leaveChat = useCallback(() => {
    chat.leave();
    fire(library.refresh());
    toDashboard();
  }, [chat, library, toDashboard]);

  /**
   * Android's back gesture is the primary way people move backwards on this platform, and React
   * Native does not wire it to anything by default — without this, back quits the app from every
   * screen. Found on the S23 FE in Phase B, which is exactly the class of thing an emulator pass
   * does not surface.
   *
   * Returning `false` passes the press on: the dashboard lets Android leave the app (correct — it
   * is the root), and the session flow registers its own handler because only it knows whether a
   * block is open.
   */
  useEffect(() => {
    const onBack = (): boolean => {
      switch (route.kind) {
        case 'dashboard':
        case 'session':
          return false;
        case 'taskEditor':
          setRoute({ kind: 'taskList' });
          return true;
        case 'chat':
          leaveChat();
          return true;
        default:
          toDashboard();
          return true;
      }
    };
    const subscription = BackHandler.addEventListener('hardwareBackPress', onBack);
    return () => subscription.remove();
  }, [route.kind, leaveChat, setRoute, toDashboard]);

  const saveTask = useCallback(async () => {
    if (await library.save()) setRoute({ kind: 'taskList' });
  }, [library, setRoute]);

  const deleteTask = useCallback(async () => {
    if (await library.remove()) setRoute({ kind: 'taskList' });
  }, [library, setRoute]);

  switch (route.kind) {
    case 'dashboard':
      return (
        <DashboardScreen
          hasTasks={libraryState.rows.length > 0}
          onStartWork={() => fire(startWork())}
          onAddTask={() => openChat({ kind: 'task_input' })}
          onReviewTasks={() => {
            fire(library.refresh());
            setRoute({ kind: 'taskList' });
          }}
          onMetrics={() => fire(openMetrics())}
          onSettings={() => setRoute({ kind: 'settings' })}
        />
      );

    case 'taskList':
      return (
        <TaskListScreen
          rows={libraryState.rows}
          onOpen={(taskId) => {
            fire(library.open(taskId));
            setRoute({ kind: 'taskEditor' });
          }}
          // The manual editor, deliberately reachable here as well as through the chat: it is the
          // only way to add a task when the model has not loaded, and sometimes you already know
          // exactly what you want and should not have to wait three seconds to say it.
          onAdd={() => {
            library.openNew();
            setRoute({ kind: 'taskEditor' });
          }}
          onBack={toDashboard}
        />
      );

    case 'taskEditor':
      return (
        <TaskEditorScreen
          draft={libraryState.draft}
          validation={libraryState.validation}
          saving={libraryState.saving}
          canDelete={libraryState.canDelete}
          onChange={(patch) => library.change(patch)}
          onSave={() => fire(saveTask())}
          onDelete={() => fire(deleteTask())}
          onBack={() => setRoute({ kind: 'taskList' })}
        />
      );

    case 'chat':
      return (
        <ChatScreen
          title={chatState.title}
          messages={chatState.messages}
          status={chatState.status}
          error={chatState.error}
          canSave={chatState.canSave}
          canResolve={chatState.canResolve}
          savedTaskTitle={chatState.savedTask?.title ?? null}
          resolution={chatState.resolution}
          onSend={(text) => fire(chat.send(text))}
          onSave={() => fire(chat.saveTask())}
          onResolve={() => fire(chat.resolve())}
          onBack={leaveChat}
        />
      );

    case 'session':
      return <SessionFlow controllers={controllers} setRoute={setRoute} openChat={openChat} />;

    case 'metrics':
      return (
        <MetricsScreen
          activeTaskCount={metrics.active}
          inProgressCount={metrics.inProgress}
          performance={metrics.performance}
          onBack={toDashboard}
        />
      );

    case 'settings':
      return (
        <SettingsScreen
          alarm={services.alarm.status()}
          notificationsGranted={notificationsGranted}
          onOpenAlarmSettings={() => services.alarm.openSettings()}
          onRequestNotifications={() =>
            fire(ensureNotificationPermission().then(setNotificationsGranted))
          }
          modelPhase="idle"
          schemaVersion={services.schemaVersion}
          onBack={toDashboard}
        />
      );
  }
}

/** The session flow. One route, and the controller's phase decides the screen. */
function SessionFlow({
  controllers,
  setRoute,
  openChat,
}: {
  controllers: Controllers;
  setRoute: (route: Route) => void;
  openChat: (purpose: ChatPurpose) => void;
}) {
  const { session } = controllers;
  const state = useControllerState(session);
  const phase: SessionPhase = state.phase;
  const [contexts, setContexts] = useState<string[]>([]);
  const [endEnergy, setEndEnergy] = useState<UserEnergy | null>(null);
  const [breakNow, setBreakNow] = useState(Date.now());

  const live = phase.kind === 'work' && phase.episodeOpen;
  const timer = useTimerSnapshot(session, live);

  // Returning to the foreground must NEVER pause (task 13 report §8): backgrounding is normal —
  // music, a call, work that happens on the phone itself. All this does is re-read whether the
  // boundary passed while the app was away.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active') fire(session.onForeground());
    });
    return () => subscription.remove();
  }, [session]);

  // The boundary can arrive while the user is looking at the work screen. The alarm interrupts
  // them when the app is closed; this is the same moment seen from inside.
  useEffect(() => {
    if (phase.kind !== 'work' || !phase.episodeOpen) return;
    if (timer?.boundaryReached) fire(session.pollBoundary(phase.item));
  }, [phase, timer, session]);

  // The session's own clock can run out while a prompt sits unanswered. Polled, deduplicated.
  useEffect(() => {
    if (phase.kind === 'summary' || phase.kind === 'planning') return;
    const id = setInterval(() => {
      fire(
        session.pollLapse().then((lapsed) => {
          if (lapsed) return session.finish();
        }),
      );
    }, 30_000);
    return () => clearInterval(id);
  }, [phase.kind, session]);

  // A break's countdown is display-only, exactly like the timer's.
  useEffect(() => {
    if (phase.kind !== 'break') return;
    const id = setInterval(() => setBreakNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [phase.kind]);

  const leaveSession = useCallback(() => {
    fire(session.abandon());
    setRoute({ kind: 'dashboard' });
  }, [session, setRoute]);

  /**
   * Leaving the work screen with a BLOCK OPEN raises the five-option prompt instead of ending the
   * session. The app never picks a disposition by inference (constraint #11's spirit): the user
   * did real work, and only they can say whether it is done, parked or declined. With no block
   * open there is nothing to dispose of, so backing out just ends the session.
   */
  const backOut = useCallback(() => {
    if (phase.kind === 'work' && phase.episodeOpen) {
      fire(session.requestEndOfBlock(phase.item));
      return;
    }
    leaveSession();
  }, [phase, session, leaveSession]);

  useEffect(() => {
    const onBack = (): boolean => {
      // The prompt is a required stop: a disposition has to be chosen, so the press is consumed.
      if (phase.kind === 'prompt') return true;
      if (phase.kind === 'summary') {
        setRoute({ kind: 'dashboard' });
        return true;
      }
      backOut();
      return true;
    };
    const subscription = BackHandler.addEventListener('hardwareBackPress', onBack);
    return () => subscription.remove();
  }, [phase.kind, backOut, setRoute]);

  const progress = useMemo(() => {
    if (!timer) return 0;
    if (timer.face === 'countup') return 0;
    const total = timer.remainingMs + timer.workedMs;
    return total > 0 ? Math.max(0, Math.min(1, timer.remainingMs / total)) : 0;
  }, [timer]);

  switch (phase.kind) {
    case 'check_in_energy':
      return (
        <CheckInEnergyScreen
          onSelect={(energy) => session.setEnergy(energy)}
          onBack={leaveSession}
        />
      );

    case 'check_in_duration':
      return (
        <CheckInDurationScreen
          choices={DURATION_CHOICES}
          onSelect={(choice) => session.setDuration(choice.minutes, choice.type)}
          onBack={leaveSession}
        />
      );

    case 'check_in_context':
      return (
        <CheckInContextScreen
          known={state.knownContexts}
          selected={contexts}
          resuming={phase.resuming}
          onToggle={(context) =>
            setContexts((current) =>
              current.includes(context)
                ? current.filter((entry) => entry !== context)
                : [...current, context],
            )
          }
          onDone={() => fire(session.setContexts(contexts))}
          onBack={leaveSession}
        />
      );

    case 'planning':
      return <Booting />;

    case 'plan_empty':
      return (
        <PlanEmptyScreen
          outcome={phase.outcome}
          splitCandidateTitle={phase.splitCandidate?.title ?? null}
          onSplit={() =>
            openChat({
              kind: 'coaching',
              trigger: 'pattern_detected',
              candidateTaskIds: phase.splitCandidate ? [phase.splitCandidate.id] : [],
            })
          }
          onCoach={() =>
            openChat({ kind: 'coaching', trigger: 'session_recalibration', candidateTaskIds: [] })
          }
          onBack={leaveSession}
        />
      );

    case 'tools':
      return (
        <ToolsCheckScreen
          taskTitle={phase.item.task.title}
          tools={phase.item.task.toolRequirements}
          onConfirm={() => session.toolsConfirmed(phase.item)}
          onMissing={() => fire(session.toolsMissing(phase.item))}
          onBack={leaveSession}
        />
      );

    case 'work':
      return (
        <WorkScreen
          taskTitle={phase.item.task.title}
          resumed={phase.item.resumeClaim || phase.item.task.workState === 'in_progress'}
          easierNote={null}
          timer={timer}
          display={formatClock(
            timer ? (timer.face === 'countup' ? timer.workedMs : timer.remainingMs) : 0,
          )}
          progress={progress}
          onStart={() => fire(session.beginBlock(phase.item))}
          onTogglePause={() => fire(timer?.paused ? session.resume() : session.pause())}
          onEndBlock={() => fire(session.requestEndOfBlock(phase.item))}
          onSomethingEasier={() => fire(session.somethingEasier())}
          onNotThisOne={() => fire(session.skip())}
          onBack={backOut}
        />
      );

    case 'prompt':
      return (
        <EndOfBlockScreen
          taskTitle={phase.item.task.title}
          workedMinutes={phase.prompt.workedMinutes}
          options={phase.prompt.options}
          selfCareNudge={phase.prompt.selfCareNudge}
          atBoundary={phase.atBoundary}
          onDone={() => fire(session.done())}
          onPlusFive={() => fire(session.plusFive(phase.item))}
          onKeepGoing={() => fire(session.keepGoing(phase.item))}
          onPark={() => fire(session.park())}
          onSkip={() => fire(session.skip())}
          onSomethingEasier={() => fire(session.somethingEasier())}
        />
      );

    case 'break':
      return (
        <BreakScreen
          minutes={phase.minutes}
          display={formatClock(phase.endsAtMs - breakNow)}
          onContinue={() => fire(session.endBreak(phase.endsAtMs))}
        />
      );

    case 'recovered':
      return (
        <RecoveredScreen
          taskTitle={phase.task.title}
          creditedMinutes={phase.creditedMinutes}
          onKeepWorking={() => fire(session.resolveRecovered(phase.task, 'keep_working'))}
          onDone={() => fire(session.resolveRecovered(phase.task, 'done'))}
          onLater={() => fire(session.resolveRecovered(phase.task, 'later'))}
        />
      );

    case 'summary':
      return (
        <SessionSummaryScreen
          summary={phase.summary}
          energy={endEnergy}
          onEnergy={(energy) => {
            setEndEnergy(energy);
            fire(session.recordEndEnergy(energy));
          }}
          onRevisitEstimate={
            phase.summary.ranLongTitles.length > 0
              ? () =>
                  openChat({
                    kind: 'coaching',
                    trigger: 'pattern_detected',
                    candidateTaskIds: [],
                  })
              : null
          }
          onDone={() => setRoute({ kind: 'dashboard' })}
        />
      );
  }
}

const styles = StyleSheet.create({
  centre: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    rowGap: spacing.lg,
    padding: spacing.xxl,
  },
});
