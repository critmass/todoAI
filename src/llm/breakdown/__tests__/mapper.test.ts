import { subtaskImportance, breakdownToSubtaskWrites, type ParentContext } from '../mapper';
import { validate } from '../validator';
import { scoreTasks, type SessionCheckIn } from '../../../scoring/score';
import type { TaskWithNeglect } from '../../../db/repositories/tasks';

describe('subtaskImportance', () => {
  // Task 10, R2: the second argument is transitive FAN-OUT, not generation index - a higher
  // fan-out (more descendants unlocked) gets a higher offset within the band.
  it('ordered: higher fan-out gets a higher offset in the parent band, starting at +1', () => {
    expect(subtaskImportance(700, 0, true)).toBe(701);
    expect(subtaskImportance(700, 1, true)).toBe(702);
    expect(subtaskImportance(700, 2, true)).toBe(703);
  });

  it('unordered: every sibling shares one value (parent+1, not the parent\'s own value)', () => {
    expect(subtaskImportance(700, 0, false)).toBe(701);
    expect(subtaskImportance(700, 1, false)).toBe(701);
    expect(subtaskImportance(700, 5, false)).toBe(701);
  });

  it('ordered values stay within the parent band and never collide with the next hundred', () => {
    for (let fanOut = 0; fanOut < 8; fanOut++) {
      // schema caps subtasks at 8, so worst case fan-out is 7 (offset 8)
      const value = subtaskImportance(700, fanOut, true);
      expect(value).toBeGreaterThan(700);
      expect(value).toBeLessThan(800);
    }
  });

  it('throws if an offset would reach the next hundred (defensive, unreachable at the 8-subtask cap)', () => {
    expect(() => subtaskImportance(700, 99, true)).toThrow();
  });
});

describe('sequentialUnlocks + transitive fan-out (via breakdownToSubtaskWrites)', () => {
  it('a chain of N ordered subtasks gives index 0 fan-out N-1, descending to 0 at the end', () => {
    const parent: ParentContext = { importance: 700, energyRequirement: 3, contextTags: [] };
    const valid = validate({
      parent_task_id: 1,
      ordered: true,
      subtasks: [
        { title: 'first', estimated_duration_minutes: 10, duration_from_user: false },
        { title: 'second', estimated_duration_minutes: 10, duration_from_user: false },
        { title: 'third', estimated_duration_minutes: 10, duration_from_user: false },
        { title: 'fourth', estimated_duration_minutes: 10, duration_from_user: false },
      ],
    });
    const writes = breakdownToSubtaskWrites(valid, parent);
    // fan-out 3,2,1,0 -> offset 4,3,2,1 -> importance 704,703,702,701
    expect(writes.map((w) => w.importance)).toEqual([704, 703, 702, 701]);
  });
});

describe('breakdownToSubtaskWrites', () => {
  const parent: ParentContext = {
    importance: 700,
    energyRequirement: 5,
    contextTags: ['home'],
  };

  it('ordered breakdown: distinct banded importance per subtask, parent context/energy copied down', () => {
    const valid = validate({
      parent_task_id: 42,
      ordered: true,
      subtasks: [
        { title: 'clear a shelf', estimated_duration_minutes: 20, duration_from_user: false },
        { title: 'sort into piles', estimated_duration_minutes: 30, duration_from_user: true },
        { title: 'haul to donation center', estimated_duration_minutes: 40, duration_from_user: false },
      ],
    });

    const writes = breakdownToSubtaskWrites(valid, parent);

    expect(writes).toHaveLength(3);
    // Task 10, R2: fan-out based, so the FIRST subtask (unlocks the other two) gets the
    // HIGHEST importance - descending, not the old ascending-by-index order that put the last
    // step of the sequence first.
    expect(writes.map((w) => w.importance)).toEqual([703, 702, 701]);
    expect(new Set(writes.map((w) => w.importance)).size).toBe(3); // all distinct

    for (const write of writes) {
      expect(write.energyRequirement).toBe(5);
      expect(write.contextTags).toEqual(['home']);
      expect(write.parentTaskId).toBe(42);
    }

    expect(writes[0].title).toBe('clear a shelf');
    expect(writes[1].estimatedDuration).toBe(30);
    expect(writes[1].durationSource).toBe('user');
    expect(writes[2].durationSource).toBe('model_guess');
  });

  it('high-leverage unblockers rank first: scoring the ordered writes surfaces step 1 before step 3', () => {
    const valid = validate({
      parent_task_id: 42,
      ordered: true,
      subtasks: [
        { title: 'clear a shelf', estimated_duration_minutes: 20, duration_from_user: false },
        { title: 'sort into piles', estimated_duration_minutes: 30, duration_from_user: false },
        { title: 'haul to donation center', estimated_duration_minutes: 40, duration_from_user: false },
      ],
    });
    const writes = breakdownToSubtaskWrites(valid, parent);

    const now = Date.UTC(2026, 6, 15);
    const checkIn: SessionCheckIn = { energy: 'high', contexts: ['home'], tools: [] };
    const pool: TaskWithNeglect[] = writes.map((write, index) => ({
      task: {
        id: index + 1,
        title: write.title ?? '',
        description: null,
        importance: write.importance ?? null,
        urgencyLevel: 3,
        nextDueAt: null,
        estimatedDuration: write.estimatedDuration ?? 0,
        durationSource: write.durationSource ?? 'model_guess',
        actualDurationHistory: [],
        averageActualDuration: null,
        energyRequirement: write.energyRequirement ?? 3,
        averageEnergyCost: 0,
        contextTags: write.contextTags ?? [],
        toolRequirements: [],
        status: 'active',
        parentTaskId: write.parentTaskId ?? null,
        createdAt: null,
        updatedAt: null,
        completionCount: 0,
        skipCount: 0,
        skipReasons: [],
        lastCompletedAt: null,
        successRate: 0,
      },
      weeksNeglected: 0,
      neglectMultiplier: 0,
    }));

    const ranked = scoreTasks(pool, checkIn, now);
    expect(ranked.map((s) => s.task.title)).toEqual([
      'clear a shelf',
      'sort into piles',
      'haul to donation center',
    ]);
  });

  it('unordered breakdown: every subtask shares one importance value', () => {
    const valid = validate({
      parent_task_id: 42,
      ordered: false,
      subtasks: [
        { title: 'call vendor A', estimated_duration_minutes: 10, duration_from_user: false },
        { title: 'call vendor B', estimated_duration_minutes: 10, duration_from_user: false },
        { title: 'call vendor C', estimated_duration_minutes: 10, duration_from_user: false },
      ],
    });

    const writes = breakdownToSubtaskWrites(valid, parent);

    expect(writes.map((w) => w.importance)).toEqual([701, 701, 701]);
  });

  it('subtask context/energy default to the parent regardless of ordered', () => {
    const otherParent: ParentContext = { importance: 300, energyRequirement: 1, contextTags: [] };
    const valid = validate({
      parent_task_id: 7,
      ordered: false,
      subtasks: [
        { title: 'a', estimated_duration_minutes: 5, duration_from_user: false },
        { title: 'b', estimated_duration_minutes: 5, duration_from_user: false },
      ],
    });

    const writes = breakdownToSubtaskWrites(valid, otherParent);
    expect(writes.every((w) => w.energyRequirement === 1 && w.contextTags?.length === 0)).toBe(true);
    expect(writes.map((w) => w.importance)).toEqual([301, 301]);
  });
});
