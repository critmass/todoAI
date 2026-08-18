// Task 24 — the task list (the prototype's "review"). Each row hands off to the editor; a calm
// line replaces the list entirely when there is nothing to show yet, rather than an empty box.

import { StyleSheet } from 'react-native';
import {
  Body,
  Card,
  Caption,
  PrimaryButton,
  Row,
  Screen,
  ScreenHeader,
  ScrollBody,
  SecondaryButton,
  Stack,
  TertiaryButton,
} from '../components';
import { colors, spacing } from '../theme';
import type { TaskListProps } from './contracts';

// Task 44 §3/§4 — quick-start and self-complete live per-row here, not on the editor: the brief
// scopes the contract change to `TaskListProps` specifically (it "currently carries only onOpen
// and onAdd"), and both actions are things you'd want without drilling into the full editor.
export default function TaskListScreen({
  rows,
  onOpen,
  onAdd,
  onBack,
  onQuickStart,
  onSelfComplete,
  selfCompletingTaskId,
}: TaskListProps) {
  return (
    <Screen>
      <ScreenHeader title="Task list" onBack={onBack} />
      <ScrollBody>
        {rows.length === 0 ? (
          <Caption>Nothing on the list yet. Add a task whenever something comes to mind.</Caption>
        ) : (
          <Stack gap={spacing.sm}>
            {rows.map((row) => (
              <Card key={row.id} onPress={() => onOpen(row.id)}>
                <Body style={styles.title}>{row.title}</Body>
                <Caption>{row.summary}</Caption>
                {row.blocked ? (
                  <Caption style={styles.blockedReason}>{row.blockedReason}</Caption>
                ) : (
                  <Row gap={spacing.sm}>
                    <SecondaryButton
                      title="Quick start"
                      onPress={() => onQuickStart(row.id)}
                      style={styles.rowButton}
                    />
                    <TertiaryButton
                      title={selfCompletingTaskId === row.id ? 'Marking done…' : 'Mark done'}
                      onPress={() => onSelfComplete(row.id)}
                      disabled={selfCompletingTaskId === row.id}
                      style={styles.rowButton}
                    />
                  </Row>
                )}
              </Card>
            ))}
          </Stack>
        )}
        <PrimaryButton title="Add task" onPress={onAdd} />
      </ScrollBody>
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { fontWeight: '600' },
  blockedReason: { color: colors.danger },
  rowButton: { flex: 1 },
});
