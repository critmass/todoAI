// Task 44 §3 — the check-in warning screen (ruling §0.4). Purely presentational, like every other
// screen: `reasons` arrives pre-built from the controller, which reused the real `src/planning/`
// predicates rather than re-deriving them here.

import { StyleSheet } from 'react-native';
import { Body, Caption, PrimaryButton, Screen, ScreenHeader, ScrollBody, SecondaryButton, Stack } from '../components';
import { colors, spacing } from '../theme';
import type { QuickStartWarningProps } from './contracts';

export default function QuickStartWarningScreen({
  taskTitle,
  reasons,
  onProceedAnyway,
  onBack,
}: QuickStartWarningProps) {
  return (
    <Screen>
      <ScreenHeader title="Before you start" onBack={onBack} />
      <ScrollBody>
        <Stack gap={spacing.lg}>
          <Body>
            "{taskTitle}" wouldn't normally have come up right now:
          </Body>
          <Stack gap={spacing.sm}>
            {reasons.map((reason, index) => (
              <Caption key={index} style={styles.reason}>
                • {reason}
              </Caption>
            ))}
          </Stack>
          <Caption>
            You can still go ahead — this is just so it's not a surprise.
          </Caption>
          <Stack gap={spacing.md}>
            <PrimaryButton title="Start anyway" onPress={onProceedAnyway} />
            <SecondaryButton title="Back out" onPress={onBack} />
          </Stack>
        </Stack>
      </ScrollBody>
    </Screen>
  );
}

const styles = StyleSheet.create({
  reason: { color: colors.danger },
});
