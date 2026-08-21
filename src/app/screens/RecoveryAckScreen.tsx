// Task 14 §13 (surface B) — "here is what was recovered and what was lost", shown once at launch
// when the recovery ladder acted. Purely presentational: `title`/`body`/`details` are built by
// `buildRecoveryAck` from the ladder's `RecoveryOutcome`, so this screen never imports the backup
// service. Spec §8.4: partial corruption TELLS the user what was recovered vs lost; total loss
// requires an explicit acknowledgement, which this button is.

import { StyleSheet } from 'react-native';
import { Body, Caption, PrimaryButton, Screen, ScreenHeader, ScrollBody, Stack } from '../components';
import { colors, spacing } from '../theme';
import type { RecoveryAckProps } from './contracts';

export default function RecoveryAckScreen({
  title,
  body,
  details,
  grave,
  onAcknowledge,
}: RecoveryAckProps) {
  return (
    <Screen>
      <ScreenHeader title={title} />
      <ScrollBody>
        <Stack gap={spacing.lg}>
          <Body>{body}</Body>
          {details.length > 0 ? (
            <Stack gap={spacing.sm}>
              {details.map((line, index) => (
                <Caption key={index} style={grave ? styles.graveLine : styles.line}>
                  • {line}
                </Caption>
              ))}
            </Stack>
          ) : null}
          <PrimaryButton title={grave ? 'I understand' : 'Continue'} onPress={onAcknowledge} />
        </Stack>
      </ScrollBody>
    </Screen>
  );
}

const styles = StyleSheet.create({
  line: { color: colors.textSecondary },
  graveLine: { color: colors.danger },
});
