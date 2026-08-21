// Task 14 §13 (surface A) — the session couldn't start. Same shape as every other screen: purely
// presentational, `reason`/`detail` arrive from the pre-session gate via the session controller.
//
// TONE follows the mismatch "Before you start" sibling (QuickStartWarningScreen): inform, reassure
// that nothing was lost, and hand the user the one thing they can actually do about it. Two reasons
// share one screen because both are "we can't safely start a session right now" — the copy differs,
// the frame does not.

import { StyleSheet } from 'react-native';
import { Body, Caption, PrimaryButton, Screen, ScreenHeader, ScrollBody, Stack } from '../components';
import { colors, spacing } from '../theme';
import type { SessionBlockedProps } from './contracts';

const COPY: Record<SessionBlockedProps['reason'], { title: string; body: string }> = {
  no_space: {
    title: 'Not enough space',
    body:
      "Before every session your data is backed up, and there isn't enough free space on your " +
      'phone to make that backup right now. Free up a little space and start again — nothing has ' +
      'been lost.',
  },
  integrity: {
    title: "Can't start just yet",
    body:
      'Something looks wrong with your saved data, so a session was held back rather than risk ' +
      'it. Close the app completely and open it again — it checks and repairs itself on the next ' +
      'start. Nothing has been deleted.',
  },
};

export default function SessionBlockedScreen({ reason, detail, onDismiss }: SessionBlockedProps) {
  const copy = COPY[reason];
  return (
    <Screen>
      <ScreenHeader title={copy.title} onBack={onDismiss} />
      <ScrollBody>
        <Stack gap={spacing.lg}>
          <Body>{copy.body}</Body>
          {detail ? <Caption style={styles.detail}>{detail}</Caption> : null}
          <PrimaryButton title="Back" onPress={onDismiss} />
        </Stack>
      </ScrollBody>
    </Screen>
  );
}

const styles = StyleSheet.create({
  detail: { color: colors.textMuted },
});
