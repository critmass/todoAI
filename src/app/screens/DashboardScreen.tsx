// Task 24 — the dashboard. Calm and centred: with tasks on hand it offers to start work first
// (the affirmative action), reviewing the list and adding a task as lighter alternatives, and
// metrics/settings as quiet links that never compete for attention. With no tasks at all, starting
// a session is not offered — there is nothing for it to plan around.

import { CenteredBody, Display, PrimaryButton, QuietLink, Screen, SecondaryButton, Stack, TertiaryButton } from '../components';
import { spacing } from '../theme';
import type { DashboardProps } from './contracts';

export default function DashboardScreen({
  hasTasks,
  onStartWork,
  onAddTask,
  onReviewTasks,
  onMetrics,
  onSettings,
}: DashboardProps) {
  return (
    <Screen>
      <CenteredBody>
        <Display>Focus</Display>
        {hasTasks ? (
          <Stack>
            <PrimaryButton title="Start work" onPress={onStartWork} />
            <SecondaryButton title="Review task list" onPress={onReviewTasks} />
            <TertiaryButton title="Add task" onPress={onAddTask} />
          </Stack>
        ) : (
          <Stack>
            <PrimaryButton title="Add task" onPress={onAddTask} />
          </Stack>
        )}
        <Stack gap={spacing.sm}>
          <QuietLink title="Metrics" onPress={onMetrics} />
          <QuietLink title="Settings" onPress={onSettings} />
        </Stack>
      </CenteredBody>
    </Screen>
  );
}
