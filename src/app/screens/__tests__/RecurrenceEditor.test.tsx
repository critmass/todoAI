// Task 46 phase 2 — the editor that makes the four scheduled repeat modes reachable.
//
// These are RENDER tests: they mount the real components and assert what a user would find on the
// screen — which control the chosen option reveals, what each grid cell is called, and what patch
// a tap produces. What they deliberately do NOT assert is how any of it LOOKS; the visual pass is
// beta-gate work and pinning pixel styles here would only make it expensive.

import { readFileSync } from 'fs';
import { join } from 'path';
import type { ReactElement } from 'react';
import { Modal, Text } from 'react-native';
import ReactTestRenderer, { type ReactTestInstance } from 'react-test-renderer';

import { Dropdown, SelectChip, TextField } from '../../components';
import {
  RECURRENCE_KINDS,
  emptyDraft,
  validateDraft,
  type TaskDraft,
} from '../../tasks/taskDraft';
import { RecurrenceEditor } from '../RecurrenceEditor';

function render(element: ReactElement): ReactTestRenderer.ReactTestRenderer {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(element);
  });
  return tree;
}

function press(instance: ReactTestInstance): void {
  ReactTestRenderer.act(() => {
    instance.props.onPress();
  });
}

/** Every string the user can actually read, in document order. */
function visibleText(root: ReactTestInstance): string[] {
  return root
    .findAllByType(Text)
    .map((node) => {
      const children: unknown = node.props.children;
      return (Array.isArray(children) ? children : [children])
        .filter((child) => typeof child === 'string' || typeof child === 'number')
        .join('');
    })
    .filter((text) => text.trim() !== '');
}

/** The one PRESSABLE with this accessibility label. `findByProps` alone would match twice — the
 *  composite and the host view it renders — so the composite is picked by the prop only it has. */
function button(root: ReactTestInstance, accessibilityLabel: string): ReactTestInstance {
  const found = root
    .findAllByProps({ accessibilityLabel })
    .filter((node) => typeof node.props.onPress === 'function');
  if (found.length !== 1) {
    throw new Error(`expected exactly one button labelled "${accessibilityLabel}", found ${found.length}`);
  }
  return found[0];
}

function chip(root: ReactTestInstance, accessibilityLabel: string): ReactTestInstance {
  const found = root
    .findAllByType(SelectChip)
    .filter((node) => node.props.accessibilityLabel === accessibilityLabel);
  if (found.length !== 1) {
    throw new Error(`expected exactly one chip labelled "${accessibilityLabel}", found ${found.length}`);
  }
  return found[0];
}

function editor(overrides: Partial<TaskDraft> = {}) {
  const draft: TaskDraft = { ...emptyDraft(), title: 'Water the plants', ...overrides };
  const onChange = jest.fn();
  const tree = render(
    <RecurrenceEditor draft={draft} onChange={onChange} validation={validateDraft(draft)} />,
  );
  return { root: tree.root, onChange, draft };
}

describe('the dropdown (task 46 phase 2 — JS only: a Pressable and React Native\'s core Modal)', () => {
  const options = [
    { value: 'a' as const, label: 'Apple' },
    { value: 'b' as const, label: 'Banana' },
  ];

  it('🔴 needs no native dependency — no picker package is installed', () => {
    const pkg = JSON.parse(
      readFileSync(join(__dirname, '..', '..', '..', '..', 'package.json'), 'utf8'),
    ) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
    const installed = [...Object.keys(pkg.dependencies), ...Object.keys(pkg.devDependencies)];
    expect(installed.filter((name) => name.includes('picker'))).toEqual([]);
  });

  it('shows the selected option, and nothing else, until it is opened', () => {
    const { root } = render(
      <Dropdown value="b" options={options} onSelect={jest.fn()} accessibilityLabel="Repeats" />,
    );
    expect(visibleText(root)).toContain('Banana');
    expect(visibleText(root)).not.toContain('Apple');
    expect(root.findAllByType(Modal)).toHaveLength(0);
  });

  it('opens React Native\'s own Modal with the whole list', () => {
    const { root } = render(
      <Dropdown value="b" options={options} onSelect={jest.fn()} accessibilityLabel="Repeats" />,
    );
    press(button(root, 'Repeats'));
    expect(root.findAllByType(Modal)).toHaveLength(1);
    expect(visibleText(root)).toEqual(expect.arrayContaining(['Apple', 'Banana']));
  });

  it('reports the chosen option and closes itself', () => {
    const onSelect = jest.fn();
    const { root } = render(
      <Dropdown value="b" options={options} onSelect={onSelect} accessibilityLabel="Repeats" />,
    );
    press(button(root, 'Repeats'));
    press(button(root, 'Apple'));
    expect(onSelect).toHaveBeenCalledWith('a');
    expect(root.findAllByType(Modal)).toHaveLength(0);
  });

  it('closes without choosing when the backdrop is tapped', () => {
    const onSelect = jest.fn();
    const { root } = render(
      <Dropdown value="b" options={options} onSelect={onSelect} accessibilityLabel="Repeats" />,
    );
    press(button(root, 'Repeats'));
    press(button(root, 'Close menu'));
    expect(onSelect).not.toHaveBeenCalled();
    expect(root.findAllByType(Modal)).toHaveLength(0);
  });
});

describe('the recurrence editor (task 46 phase 2)', () => {
  describe('the top line', () => {
    it('is one dropdown carrying every option, in the ruled order', () => {
      const { root } = editor();
      const dropdowns = root.findAllByType(Dropdown);
      expect(dropdowns).toHaveLength(1);
      expect(dropdowns[0].props.options).toEqual(
        RECURRENCE_KINDS.map(({ kind, label }) => ({ value: kind, label })),
      );
      expect(dropdowns[0].props.value).toBe('once');
    });

    it('🔴 clears the weekdays in the very patch that picks a month-driven mode', () => {
      const { root, onChange } = editor({ kind: 'schedule', scheduledDays: ['monday', 'thursday'] });
      ReactTestRenderer.act(() => {
        root.findByType(Dropdown).props.onSelect('schedule_dates');
      });
      expect(onChange).toHaveBeenCalledWith({ kind: 'schedule_dates', scheduledDays: [] });
    });

    it('keeps the weekdays when the mode picked is still weekday-driven', () => {
      const { root, onChange } = editor({ kind: 'schedule', scheduledDays: ['monday'] });
      ReactTestRenderer.act(() => {
        root.findByType(Dropdown).props.onSelect('schedule_interval');
      });
      expect(onChange).toHaveBeenCalledWith({ kind: 'schedule_interval' });
    });
  });

  describe('the region beneath re-shapes to the selection', () => {
    it('One-time reveals the date field and no schedule controls at all', () => {
      const { root } = editor({ kind: 'once' });
      expect(root.findAllByType(TextField)).toHaveLength(1);
      expect(root.findAllByType(SelectChip)).toHaveLength(0);
    });

    it('Weekly reveals the seven weekday chips and nothing else', () => {
      const { root } = editor({ kind: 'schedule', scheduledDays: ['monday'] });
      expect(root.findAllByType(SelectChip)).toHaveLength(7);
      expect(chip(root, 'Monday').props.selected).toBe(true);
      expect(chip(root, 'Tuesday').props.selected).toBe(false);
      expect(root.findAllByType(TextField)).toHaveLength(0);
    });

    it('Every N weeks reveals the weekday chips AND the interval', () => {
      const { root, onChange } = editor({
        kind: 'schedule_interval',
        scheduledDays: ['tuesday'],
        weekInterval: '3',
      });
      expect(root.findAllByType(SelectChip)).toHaveLength(7);
      const fields = root.findAllByType(TextField);
      expect(fields).toHaveLength(1);
      expect(fields[0].props.value).toBe('3');
      ReactTestRenderer.act(() => {
        fields[0].props.onChangeText('4');
      });
      expect(onChange).toHaveBeenCalledWith({ weekInterval: '4' });
    });

    it('Ongoing reveals no controls, only its explanation', () => {
      const { root } = editor({ kind: 'ongoing' });
      expect(root.findAllByType(SelectChip)).toHaveLength(0);
      expect(root.findAllByType(TextField)).toHaveLength(0);
    });
  });

  describe('Weeks of the month — the 6×7 grid', () => {
    it('is 42 cells: columns Sunday–Saturday, rows 1st…Last, and NO weekday chip row', () => {
      const { root } = editor({ kind: 'schedule_ordinal', ordinalCells: [] });
      const cells = root
        .findAllByType(SelectChip)
        .filter((node) => /^(1st|2nd|3rd|4th|5th|Last) /.test(node.props.accessibilityLabel ?? ''));
      expect(cells).toHaveLength(42);
      // The chips are the grid and nothing but the grid — a weekday row feeding it would be the
      // cross product the phase 1 amendment removed.
      expect(root.findAllByType(SelectChip)).toHaveLength(42);
      const labels = visibleText(root);
      expect(labels).toEqual(expect.arrayContaining(['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']));
      expect(labels).toEqual(expect.arrayContaining(['1st', '2nd', '3rd', '4th', '5th', 'Last']));
    });

    it('🔴 ticking one cell adds exactly ONE occurrence', () => {
      const { root, onChange } = editor({ kind: 'schedule_ordinal', ordinalCells: [] });
      press(chip(root, '3rd Wednesday'));
      expect(onChange).toHaveBeenCalledWith({
        ordinalCells: [{ ordinal: 3, weekday: 'wednesday' }],
      });
    });

    it('shows a ticked cell as ticked, and un-ticks it on a second tap', () => {
      const { root, onChange } = editor({
        kind: 'schedule_ordinal',
        ordinalCells: [{ ordinal: 1, weekday: 'monday' }],
      });
      expect(chip(root, '1st Monday').props.selected).toBe(true);
      expect(chip(root, 'Last Friday').props.selected).toBe(false);
      press(chip(root, '1st Monday'));
      expect(onChange).toHaveBeenCalledWith({ ordinalCells: [] });
    });

    it('keeps the 5th row and the Last row as separate cells', () => {
      const { root, onChange } = editor({
        kind: 'schedule_ordinal',
        ordinalCells: [{ ordinal: 'last', weekday: 'wednesday' }],
      });
      expect(chip(root, '5th Wednesday').props.selected).toBe(false);
      press(chip(root, '5th Wednesday'));
      expect(onChange).toHaveBeenCalledWith({
        ordinalCells: [
          { ordinal: 'last', weekday: 'wednesday' },
          { ordinal: 5, weekday: 'wednesday' },
        ],
      });
    });

    it('says what an empty grid is missing', () => {
      const { root } = editor({ kind: 'schedule_ordinal', ordinalCells: [] });
      expect(visibleText(root)).toContain('Tick at least one box.');
    });
  });

  describe('Dates — the 31-cell grid', () => {
    it('is 31 checkboxes, 1 to 31', () => {
      const { root } = editor({ kind: 'schedule_dates', monthDays: [] });
      expect(root.findAllByType(SelectChip)).toHaveLength(31);
      expect(chip(root, 'Day 1')).toBeDefined();
      expect(chip(root, 'Day 31')).toBeDefined();
    });

    it('ticks a date', () => {
      const { root, onChange } = editor({ kind: 'schedule_dates', monthDays: [1] });
      expect(chip(root, 'Day 1').props.selected).toBe(true);
      press(chip(root, 'Day 15'));
      expect(onChange).toHaveBeenCalledWith({ monthDays: [1, 15] });
    });

    it('offers the month stride, in both month-driven modes', () => {
      const dates = editor({ kind: 'schedule_dates', monthDays: [1], monthInterval: '2' });
      const datesField = dates.root.findAllByType(TextField);
      expect(datesField).toHaveLength(1);
      expect(datesField[0].props.value).toBe('2');
      ReactTestRenderer.act(() => {
        datesField[0].props.onChangeText('3');
      });
      expect(dates.onChange).toHaveBeenCalledWith({ monthInterval: '3' });

      const ordinal = editor({
        kind: 'schedule_ordinal',
        ordinalCells: [{ ordinal: 1, weekday: 'monday' }],
        monthInterval: '4',
      });
      expect(ordinal.root.findAllByType(TextField)[0].props.value).toBe('4');
    });

    it('says what an empty grid is missing', () => {
      const { root } = editor({ kind: 'schedule_dates', monthDays: [] });
      expect(visibleText(root)).toContain('Pick at least one date.');
    });
  });

  describe('the kinds that existed before task 46 are untouched', () => {
    it('Quota still offers its number and its three periods', () => {
      const { root } = editor({ kind: 'quota', quota: '3' });
      expect(root.findAllByType(TextField)[0].props.value).toBe('3');
      expect(root.findAllByType(SelectChip)).toHaveLength(3);
    });

    it('Quota + days still offers the quota AND the weekday chips', () => {
      const { root } = editor({ kind: 'quota_schedule', quota: '3', scheduledDays: ['monday'] });
      expect(root.findAllByType(SelectChip)).toHaveLength(3 + 7);
    });

    it('N times total still shows progress', () => {
      const { root } = editor({ kind: 'count', target: '10', progress: 3 });
      expect(visibleText(root)).toContain('3 done so far.');
    });
  });
});
