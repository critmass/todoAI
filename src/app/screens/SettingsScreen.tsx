// Task 24 — settings, minimal for the personal ship. Plain statements of fact rather than
// toggles-with-explanations: the alarm and notification sections each say exactly where things
// stand and offer the one action that would change it.

import { Body, Caption, Heading, Screen, ScreenHeader, ScrollBody, SecondaryButton, Stack, StatRow } from '../components';
import { spacing } from '../theme';
import type { SettingsProps } from './contracts';

const MODEL_PHASE_LABEL: Record<SettingsProps['modelPhase'], string> = {
  idle: 'Not loaded yet',
  loading: 'Loading…',
  checking_grammars: 'Checking grammars…',
  ready: 'Ready',
  failed: 'Failed to load',
};

export default function SettingsScreen({
  alarm,
  notificationsGranted,
  onOpenAlarmSettings,
  onRequestNotifications,
  modelPhase,
  schemaVersion,
  onBack,
}: SettingsProps) {
  return (
    <Screen>
      <ScreenHeader title="Settings" onBack={onBack} />
      <ScrollBody>
        <Stack gap={spacing.sm}>
          <Heading>Block alarm</Heading>
          {!alarm.available ? (
            <Caption>
              The alarm isn't available in this build — the timer still works, it just won't nudge you when a
              block ends.
            </Caption>
          ) : alarm.exact ? (
            <Caption>The alarm is set to fire exactly on time.</Caption>
          ) : (
            <Stack gap={spacing.sm}>
              <Caption>
                Android is batching alarms on this device, so the end-of-block nudge may arrive a little late.
              </Caption>
              <SecondaryButton title="Allow exact alarms" onPress={onOpenAlarmSettings} />
            </Stack>
          )}
        </Stack>

        <Stack gap={spacing.sm}>
          <Heading>Notifications</Heading>
          {notificationsGranted ? (
            <Caption>Notifications are on.</Caption>
          ) : (
            <SecondaryButton title="Turn on notifications" onPress={onRequestNotifications} />
          )}
        </Stack>

        <Stack gap={spacing.sm}>
          <Heading>Model</Heading>
          <Body>{MODEL_PHASE_LABEL[modelPhase]}</Body>
        </Stack>

        <Stack gap={spacing.sm}>
          <Heading>Database</Heading>
          <StatRow label="Schema version" value={schemaVersion} />
        </Stack>
      </ScrollBody>
    </Screen>
  );
}
