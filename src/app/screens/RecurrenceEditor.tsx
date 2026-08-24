// Task 24, extended by task 46 phase 2 — the recurrence editor.
//
// THE SHAPE IS RULED (Jason, 2026-08-24): one top-line dropdown carrying every option, with the
// region beneath re-shaping to the selection. A form that expands by selection is completely
// ordinary, and a dropdown keeps that top line at ONE line however many options exist, where the
// original chip row already wrapped at six and would wrap to three rows at nine.
//
// The dropdown is JS-only — a `Pressable` and React Native's core `Modal` (see `Dropdown` in
// ../components). No native picker, so no rebuild and no run at the `.cxx` codegen trap.
//
// 🔴 The two grids are LAYOUT, not new primitives: `SelectChip` is already a toggle, sized down by
// a style. And each ticked cell of the 6×7 grid is ONE occurrence — "1st Monday + 3rd Wednesday"
// is two, not the four a row × column cross product would produce. That cross product is exactly
// what the phase 1 amendment removed from the engine; it must not come back in the UI.
//
// Still purely presentational: every control patches the draft and nothing else.

import { StyleSheet, View } from 'react-native';
import { Body, Caption, Dropdown, Row, SelectChip, Stack, TextField } from '../components';
import { colors, spacing } from '../theme';
import {
  GRID_WEEKDAYS,
  MONTH_DAYS,
  ORDINAL_ROWS,
  PERIODS,
  RECURRENCE_KINDS,
  WEEKDAYS,
  isOrdinalCellTicked,
  recurrenceKindPatch,
  toggleMonthDay,
  toggleOrdinalCell,
  type DraftValidation,
  type TaskDraft,
} from '../tasks/taskDraft';
import type { Weekday } from '../../types/domain';

interface RecurrenceEditorProps {
  draft: TaskDraft;
  onChange: (patch: Partial<TaskDraft>) => void;
  validation: DraftValidation;
}

const KIND_OPTIONS = RECURRENCE_KINDS.map(({ kind, label }) => ({ value: kind, label }));

/** The 31 date checkboxes in calendar-shaped rows of seven. */
const DATE_ROWS: number[][] = MONTH_DAYS.reduce<number[][]>((rows, day, index) => {
  if (index % 7 === 0) rows.push([]);
  rows[rows.length - 1].push(day);
  return rows;
}, []);

function dayName(day: Weekday): string {
  return day.charAt(0).toUpperCase() + day.slice(1);
}

export function RecurrenceEditor({ draft, onChange, validation }: RecurrenceEditorProps) {
  function toggleDay(day: Weekday) {
    const scheduledDays = draft.scheduledDays.includes(day)
      ? draft.scheduledDays.filter((d) => d !== day)
      : [...draft.scheduledDays, day];
    onChange({ scheduledDays });
  }

  function error(message: string | undefined) {
    return message ? <Caption style={styles.errorText}>{message}</Caption> : null;
  }

  const dayChips = (
    <Stack gap={spacing.xs}>
      <Row>
        {WEEKDAYS.map(({ day, short }) => (
          <SelectChip
            key={day}
            label={short}
            accessibilityLabel={dayName(day)}
            selected={draft.scheduledDays.includes(day)}
            onPress={() => toggleDay(day)}
          />
        ))}
      </Row>
      {error(validation.errors.days)}
    </Stack>
  );

  const weekIntervalField = (
    <Stack gap={spacing.xs}>
      <Row>
        <Body>every</Body>
        <TextField
          value={draft.weekInterval}
          onChangeText={(weekInterval) => onChange({ weekInterval })}
          keyboardType="number-pad"
          style={styles.smallField}
        />
        <Body>weeks</Body>
      </Row>
      {error(validation.errors.weekInterval)}
      {/* No date-picker exists anywhere in the app, by design — so say where the count starts from
          rather than leaving the user to guess. */}
      <Caption>Counted from the day you first added the task.</Caption>
    </Stack>
  );

  const monthIntervalField = (
    <Stack gap={spacing.xs}>
      <Row>
        <Body>every</Body>
        <TextField
          value={draft.monthInterval}
          onChangeText={(monthInterval) => onChange({ monthInterval })}
          keyboardType="number-pad"
          style={styles.smallField}
        />
        <Body>months</Body>
      </Row>
      {error(validation.errors.monthInterval)}
    </Stack>
  );

  // The 6×7 grid: columns Sunday–Saturday, rows 1st…Last. Each box is one occurrence.
  const ordinalGrid = (
    <Stack gap={spacing.xs}>
      <Row gap={spacing.xs}>
        <View style={styles.gridRowLabel} />
        {GRID_WEEKDAYS.map(({ day, short }) => (
          <Caption key={day} style={styles.gridHeadCell}>
            {short}
          </Caption>
        ))}
      </Row>
      {ORDINAL_ROWS.map((row) => (
        <Row key={String(row.ordinal)} gap={spacing.xs}>
          <Caption style={styles.gridRowLabel}>{row.label}</Caption>
          {GRID_WEEKDAYS.map(({ day }) => {
            const cell = { ordinal: row.ordinal, weekday: day };
            const ticked = isOrdinalCellTicked(draft.ordinalCells, cell);
            return (
              <SelectChip
                key={day}
                label={ticked ? '✓' : ''}
                accessibilityLabel={`${row.label} ${dayName(day)}`}
                selected={ticked}
                onPress={() => onChange({ ordinalCells: toggleOrdinalCell(draft.ordinalCells, cell) })}
                style={styles.gridCell}
              />
            );
          })}
        </Row>
      ))}
      {error(validation.errors.cells)}
      {/* The one box in this grid whose meaning is easy to get wrong (phase 1 amendment §6). */}
      <Caption>
        Every box you tick is one occurrence. "5th" and "Last" are not the same thing: in a month
        with only four Wednesdays, a 5th Wednesday never comes round.
      </Caption>
    </Stack>
  );

  const datesGrid = (
    <Stack gap={spacing.xs}>
      {DATE_ROWS.map((week) => (
        <Row key={week[0]} gap={spacing.xs}>
          {week.map((day) => (
            <SelectChip
              key={day}
              label={String(day)}
              accessibilityLabel={`Day ${day}`}
              selected={draft.monthDays.includes(day)}
              onPress={() => onChange({ monthDays: toggleMonthDay(draft.monthDays, day) })}
              style={styles.gridCell}
            />
          ))}
        </Row>
      ))}
      {error(validation.errors.monthDays)}
      <Caption>A month without that date simply skips it — the 31st, in February.</Caption>
    </Stack>
  );

  const quotaFields = (
    <Stack gap={spacing.xs}>
      <Row>
        <TextField
          value={draft.quota}
          onChangeText={(quota) => onChange({ quota })}
          keyboardType="number-pad"
          style={styles.smallField}
        />
        <Body>times a</Body>
        {PERIODS.map((period) => (
          <SelectChip
            key={period}
            label={period}
            selected={draft.period === period}
            onPress={() => onChange({ period })}
          />
        ))}
      </Row>
      {error(validation.errors.quota)}
    </Stack>
  );

  return (
    <Stack gap={spacing.md}>
      <Dropdown
        value={draft.kind}
        options={KIND_OPTIONS}
        onSelect={(kind) => onChange(recurrenceKindPatch(kind))}
        accessibilityLabel="How often this repeats"
      />

      {draft.kind === 'once' ? (
        <Stack gap={spacing.xs}>
          <TextField
            value={draft.dueDate}
            onChangeText={(dueDate) => onChange({ dueDate })}
            placeholder="YYYY-MM-DD"
          />
          <Caption>Leaving this blank is fine.</Caption>
        </Stack>
      ) : null}

      {draft.kind === 'schedule' ? dayChips : null}

      {draft.kind === 'schedule_interval' ? (
        <Stack gap={spacing.md}>
          {dayChips}
          {weekIntervalField}
        </Stack>
      ) : null}

      {draft.kind === 'schedule_ordinal' ? (
        <Stack gap={spacing.md}>
          {ordinalGrid}
          {monthIntervalField}
        </Stack>
      ) : null}

      {draft.kind === 'schedule_dates' ? (
        <Stack gap={spacing.md}>
          {datesGrid}
          {monthIntervalField}
        </Stack>
      ) : null}

      {draft.kind === 'quota' ? quotaFields : null}

      {draft.kind === 'quota_schedule' ? (
        <Stack gap={spacing.md}>
          {quotaFields}
          {dayChips}
        </Stack>
      ) : null}

      {draft.kind === 'ongoing' ? (
        <Caption>No schedule. This one resurfaces on its own when it fits the moment.</Caption>
      ) : null}

      {draft.kind === 'count' ? (
        <Stack gap={spacing.xs}>
          <Row>
            <TextField
              value={draft.target}
              onChangeText={(target) => onChange({ target })}
              keyboardType="number-pad"
              style={styles.smallField}
            />
            <Body>times total, then done</Body>
          </Row>
          <Caption>{draft.progress} done so far.</Caption>
          {error(validation.errors.target)}
        </Stack>
      ) : null}
    </Stack>
  );
}

const styles = StyleSheet.create({
  smallField: { width: 64, textAlign: 'center' },
  errorText: { color: colors.danger },
  // The grids: a fixed cell so the columns line up under their headings, and no horizontal padding
  // because a pill's own padding would make seven of them wider than a phone.
  // 30 + 7×36 + 7 gaps of 4 = 310, inside the editor's 32pt of page padding: 342 of a 360pt phone,
  // so the seven columns fit the narrowest screen the app targets with room to spare. `Row` wraps
  // rather than clipping if a future font scale eats that margin.
  gridCell: { width: 36, paddingHorizontal: 0, alignItems: 'center' },
  gridHeadCell: { width: 36, textAlign: 'center' },
  gridRowLabel: { width: 30 },
});
