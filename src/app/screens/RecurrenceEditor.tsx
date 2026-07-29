// Task 24 — the recurrence editor. Six mutually exclusive kinds as a wrapping row of chips; only
// the chosen kind's own fields ever appear beneath it. Six choices is already a lot for an
// ADHD-minimal surface, so showing all six kinds' fields at once was never on the table — the
// unselected kinds stay quiet pills and nothing else about them takes up room on screen.

import { StyleSheet } from 'react-native';
import { Body, Caption, Row, SelectChip, Stack, TextField } from '../components';
import { colors, spacing } from '../theme';
import {
  PERIODS,
  RECURRENCE_KINDS,
  WEEKDAYS,
  type DraftValidation,
  type TaskDraft,
} from '../tasks/taskDraft';
import type { Weekday } from '../../types/domain';

interface RecurrenceEditorProps {
  draft: TaskDraft;
  onChange: (patch: Partial<TaskDraft>) => void;
  validation: DraftValidation;
}

export function RecurrenceEditor({ draft, onChange, validation }: RecurrenceEditorProps) {
  function toggleDay(day: Weekday) {
    const scheduledDays = draft.scheduledDays.includes(day)
      ? draft.scheduledDays.filter((d) => d !== day)
      : [...draft.scheduledDays, day];
    onChange({ scheduledDays });
  }

  const dayChips = (
    <Stack gap={spacing.xs}>
      <Row>
        {WEEKDAYS.map(({ day, short }) => (
          <SelectChip
            key={day}
            label={short}
            selected={draft.scheduledDays.includes(day)}
            onPress={() => toggleDay(day)}
          />
        ))}
      </Row>
      {validation.errors.days ? <Caption style={styles.errorText}>{validation.errors.days}</Caption> : null}
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
      {validation.errors.quota ? <Caption style={styles.errorText}>{validation.errors.quota}</Caption> : null}
    </Stack>
  );

  return (
    <Stack gap={spacing.md}>
      <Row>
        {RECURRENCE_KINDS.map(({ kind, label }) => (
          <SelectChip key={kind} label={label} selected={draft.kind === kind} onPress={() => onChange({ kind })} />
        ))}
      </Row>

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
          {validation.errors.target ? <Caption style={styles.errorText}>{validation.errors.target}</Caption> : null}
        </Stack>
      ) : null}
    </Stack>
  );
}

const styles = StyleSheet.create({
  smallField: { width: 64, textAlign: 'center' },
  errorText: { color: colors.danger },
});
