// Task 24 — the task list (the prototype's "review"). Each row hands off to the editor; a calm
// line replaces the list entirely when there is nothing to show yet, rather than an empty box.

import { StyleSheet } from 'react-native';
import { Body, Card, Caption, PrimaryButton, Screen, ScreenHeader, ScrollBody, Stack } from '../components';
import { spacing } from '../theme';
import type { TaskListProps } from './contracts';

export default function TaskListScreen({ rows, onOpen, onAdd, onBack }: TaskListProps) {
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
});
