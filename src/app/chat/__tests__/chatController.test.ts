// Task 24 — the chat surface. The load-bearing test here is the first one: the crisis gate fires
// app-side, ahead of the model, and the model is provably never consulted. Task 7's Phase B put
// the same words to the 4B and got back a suggestion to try a 10-minute task, which is why
// detection can never be the model's job.

import { createTestConnection, type TestSqliteConnection } from '../../../db/testUtils/sqliteTestConnection';
import { runMigrations } from '../../../db/migrations';
import { createCoachingRepository } from '../../../db/repositories/coaching';
import { createDependenciesRepository } from '../../../db/repositories/dependencies';
import { createRecurrenceRepository } from '../../../db/repositories/recurrence';
import { createTasksRepository } from '../../../db/repositories/tasks';
import { CRISIS_REFERRAL_TEXT } from '../../../llm/prompts';
import { MockLLMProvider } from '../../../llm/provider';
import { createChatController } from '../chatController';
import type { ModelHost } from '../modelHost';

const VALID_EXTRACTION = JSON.stringify({
  title: 'Call the dentist',
  description: null,
  estimated_duration_minutes: 10,
  duration_from_user: false,
  duration_type: 'estimate',
  due: null,
  context_tags: ['phone'],
  tool_requirements: ['phone'],
  energy: 'low',
  importance_user: null,
  recurrence: null,
});

const REPEATING_EXTRACTION = JSON.stringify({
  title: 'Stretch',
  description: null,
  estimated_duration_minutes: 5,
  duration_from_user: true,
  duration_type: 'estimate',
  due: null,
  context_tags: [],
  tool_requirements: [],
  energy: 'low',
  importance_user: null,
  recurrence: { type: 'quota', quota: 3, period: 'week' },
});

describe('chat controller (task 24)', () => {
  let conn: TestSqliteConnection;
  let tasks: ReturnType<typeof createTasksRepository>;
  let recurrence: ReturnType<typeof createRecurrenceRepository>;
  let coaching: ReturnType<typeof createCoachingRepository>;
  let dependencies: ReturnType<typeof createDependenciesRepository>;

  function hostFor(provider: MockLLMProvider, grammarEnabled = true): ModelHost {
    return {
      ensure: async () => ({ provider, grammarEnabled }),
      isReady: () => true,
      phase: () => 'ready',
    };
  }

  function controller(provider: MockLLMProvider, grammarEnabled = true) {
    return createChatController({
      model: hostFor(provider, grammarEnabled),
      tasks,
      recurrence,
      coaching,
      dispatch: { tasks, dependencies },
      now: () => Date.UTC(2026, 6, 28, 12, 0, 0),
    });
  }

  beforeEach(async () => {
    conn = createTestConnection();
    await runMigrations(conn);
    tasks = createTasksRepository(conn);
    recurrence = createRecurrenceRepository(conn);
    coaching = createCoachingRepository(conn);
    dependencies = createDependenciesRepository(conn);
  });

  afterEach(() => conn.close());

  describe('the crisis gate', () => {
    it('halts before the model is ever called, with the fixed reviewed copy', async () => {
      const provider = new MockLLMProvider({ responses: ['this must never be reached'] });
      const chat = controller(provider);
      chat.open({ kind: 'coaching', trigger: 'task_skipped', candidateTaskIds: [] });

      await chat.send("Honestly I don't see the point in any of it anymore. I don't really want to be here.");

      expect(provider.calls).toHaveLength(0);
      const state = chat.getState();
      expect(state.status).toBe('halted');
      expect(state.messages[state.messages.length - 1].text).toBe(CRISIS_REFERRAL_TEXT);
      expect(state.canResolve).toBe(false);
    });

    it('refuses any further turn once halted', async () => {
      const provider = new MockLLMProvider({ responses: ['nope'] });
      const chat = controller(provider);
      chat.open({ kind: 'task_input' });
      await chat.send('I want to be dead');
      await chat.send('sorry, ignore that, I need to call the dentist');
      expect(provider.calls).toHaveLength(0);
    });

    it('each purpose offers only its own closing action', async () => {
      const coach = new MockLLMProvider({ responses: ['Fair enough.'] });
      const coachChat = controller(coach);
      coachChat.open({ kind: 'coaching', trigger: 'task_skipped', candidateTaskIds: [] });
      await coachChat.send('I keep putting it off.');
      // Never offer to extract a task out of a conversation about why something was hard.
      expect(coachChat.getState().canSave).toBe(false);
      expect(coachChat.getState().canResolve).toBe(true);

      const capture = new MockLLMProvider({ responses: ['So: call the dentist?'] });
      const input = controller(capture);
      input.open({ kind: 'task_input' });
      await input.send('I need to call the dentist');
      expect(input.getState().canSave).toBe(true);
      expect(input.getState().canResolve).toBe(false);
    });

    it('is discriminating — an ordinary complaint goes through to the model', async () => {
      const provider = new MockLLMProvider({ responses: ['That inbox sounds like a wall.'] });
      const chat = controller(provider);
      chat.open({ kind: 'coaching', trigger: 'task_skipped', candidateTaskIds: [] });
      await chat.send('I keep skipping the inbox, 45 minutes of it feels impossible.');

      expect(provider.calls).toHaveLength(1);
      expect(chat.getState().status).toBe('idle');
    });
  });

  describe('task input', () => {
    it('takes a prose turn first, so the model can ask before the grammar forces an answer', async () => {
      const provider = new MockLLMProvider({
        responses: ['So: call the dentist, about ten minutes, no particular deadline?'],
      });
      const chat = controller(provider);
      chat.open({ kind: 'task_input' });
      await chat.send('I need to call the dentist');

      // The prose turn is unconstrained — that is the only place a clarifying question can happen.
      expect(provider.calls[0].opts.grammar).toBeUndefined();
      expect(chat.getState().canSave).toBe(true);
    });

    it('saves the extracted task, with no recurrence row for a one-off', async () => {
      const provider = new MockLLMProvider({
        responses: ['So: call the dentist, about ten minutes?', VALID_EXTRACTION],
      });
      const chat = controller(provider);
      chat.open({ kind: 'task_input' });
      await chat.send('I need to call the dentist');
      await chat.saveTask();

      const [created] = await tasks.listActive();
      expect(created.title).toBe('Call the dentist');
      expect(created.estimatedDuration).toBe(10);
      expect(created.toolRequirements).toEqual(['phone']);
      // Constraint #6: 'low' → internal 1, never the label.
      expect(created.energyRequirement).toBe(1);
      // Constraint #7: null recurrence means NO row, not {type:'unscheduled'}.
      expect(await recurrence.getByTaskId(created.id)).toBeUndefined();
      expect(chat.getState().savedTask?.title).toBe('Call the dentist');
    });

    it('writes the recurrence row when the extraction has one', async () => {
      const provider = new MockLLMProvider({
        responses: ['Stretching three times a week, five minutes?', REPEATING_EXTRACTION],
      });
      const chat = controller(provider);
      chat.open({ kind: 'task_input' });
      await chat.send('I want to stretch three times a week');
      await chat.saveTask();

      const [created] = await tasks.listActive();
      expect(await recurrence.getByTaskId(created.id)).toEqual({
        type: 'quota',
        quota: 3,
        period: 'week',
      });
    });

    it('runs the extraction under a grammar, greedily', async () => {
      const provider = new MockLLMProvider({ responses: ['recap', VALID_EXTRACTION] });
      const chat = controller(provider);
      chat.open({ kind: 'task_input' });
      await chat.send('I need to call the dentist');
      await chat.saveTask();

      const extractionCall = provider.calls[1];
      expect(extractionCall.opts.grammar).toContain('root');
      expect(extractionCall.opts.temperature).toBe(0);
      expect(extractionCall.opts.topK).toBe(1);
    });

    it('falls back to prompt-JSON when the startup guard disabled grammars', async () => {
      const provider = new MockLLMProvider({ responses: ['recap', VALID_EXTRACTION] });
      const chat = controller(provider, false);
      chat.open({ kind: 'task_input' });
      await chat.send('I need to call the dentist');
      await chat.saveTask();

      expect(provider.calls[1].opts.grammar).toBeUndefined();
      expect((await tasks.listActive())[0].title).toBe('Call the dentist');
    });

    it('says so, and saves nothing, when the extraction cannot be validated', async () => {
      const provider = new MockLLMProvider({
        responses: ['recap', '{"title":"broken"}', '{"title":"still broken"}'],
      });
      const chat = controller(provider);
      chat.open({ kind: 'task_input' });
      await chat.send('something vague');
      await chat.saveTask();

      expect(await tasks.listActive()).toHaveLength(0);
      expect(chat.getState().savedTask).toBeNull();
      expect(chat.getState().status).toBe('idle');
    });
  });

  describe('coaching disposition', () => {
    it('dispatches a validated resolution and resolves the queue row', async () => {
      const task = await tasks.create({ title: 'Clean out inbox', estimatedDuration: 45 });
      const queued = await coaching.create({ triggerType: 'task_skipped', urgency: 'next_start' });
      const resolution = JSON.stringify({
        action: 'modify_task',
        task_id: task.id,
        changes: {
          duration_minutes: 15,
          context_tags: null,
          energy: null,
          approach_notes: null,
        },
      });
      const provider = new MockLLMProvider({ responses: ['That sounds like a wall.', resolution] });

      const chat = controller(provider);
      chat.open({
        kind: 'coaching',
        trigger: 'task_skipped',
        queueEntryId: queued.id,
        candidateTaskIds: [task.id],
      });
      await chat.send('45 minutes of inbox feels impossible. Fifteen I could do.');
      await chat.resolve();

      expect((await tasks.getById(task.id))?.estimatedDuration).toBe(15);
      expect((await coaching.getById(queued.id))?.status).toBe('resolved');
      expect(chat.getState().resolution).not.toBeNull();
    });

    it('skips the disposition entirely when the conversation is not about one task', async () => {
      const queued = await coaching.create({
        triggerType: 'session_recalibration',
        urgency: 'immediate',
      });
      const provider = new MockLLMProvider({ responses: ['Fair enough. What does feel doable?'] });
      const chat = controller(provider);
      chat.open({
        kind: 'coaching',
        trigger: 'session_recalibration',
        queueEntryId: queued.id,
        candidateTaskIds: [],
      });
      await chat.send("I've skipped three things, I'm fried.");
      await chat.resolve();

      // One prose call, no resolution call: there is no single task to dispose of.
      expect(provider.calls).toHaveLength(1);
      expect((await coaching.getById(queued.id))?.status).toBe('resolved');
    });

    it('leaves the queue row pending when the user just walks away', async () => {
      const queued = await coaching.create({ triggerType: 'task_skipped', urgency: 'next_start' });
      const provider = new MockLLMProvider({ responses: ['ok'] });
      const chat = controller(provider);
      chat.open({
        kind: 'coaching',
        trigger: 'task_skipped',
        queueEntryId: queued.id,
        candidateTaskIds: [],
      });
      chat.leave();
      expect((await coaching.getById(queued.id))?.status).toBe('pending');
    });
  });
});
