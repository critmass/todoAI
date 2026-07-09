import { subtaskImportance, breakdownToSubtaskWrites, type ParentContext } from '../mapper';
import { validate } from '../validator';

describe('subtaskImportance', () => {
  it('ordered: gives sequential values in the parent band, starting at +1', () => {
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
    for (let index = 0; index < 8; index++) {
      // schema caps subtasks at 8, so worst case is offset 8
      const value = subtaskImportance(700, index, true);
      expect(value).toBeGreaterThan(700);
      expect(value).toBeLessThan(800);
    }
  });

  it('throws if an offset would reach the next hundred (defensive, unreachable at the 8-subtask cap)', () => {
    expect(() => subtaskImportance(700, 99, true)).toThrow();
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
    expect(writes.map((w) => w.importance)).toEqual([701, 702, 703]);
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
