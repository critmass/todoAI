// Task 24 — the app came back after being killed mid-block (spec §8.2's crash recovery). No
// prototype block covers this either. The one job of this screen is to never sound like the user
// did something wrong: the work is credited and safe, and what happens next is entirely their call.

import { StyleSheet, View } from 'react-native';

import { Body, CenteredBody, Heading, PrimaryButton, Screen, SecondaryButton, Stack, TertiaryButton } from '../components';
import { spacing } from '../theme';
import type { RecoveredProps } from './contracts';

export default function RecoveredScreen({
  taskTitle,
  creditedMinutes,
  onKeepWorking,
  onDone,
  onLater,
}: RecoveredProps) {
  return (
    <Screen>
      <CenteredBody>
        <View style={styles.center}>
          <Heading>You're back.</Heading>
        </View>
        <View style={styles.center}>
          <Body style={styles.centerText}>
            {creditedMinutes} minute{creditedMinutes === 1 ? '' : 's'} on "{taskTitle}"{' '}
            {creditedMinutes === 1 ? 'is' : 'are'} already saved — nothing was lost while you were away.
          </Body>
        </View>
        <Stack gap={spacing.md}>
          <PrimaryButton title="Keep working on it" onPress={onKeepWorking} />
          <SecondaryButton title="It's done" onPress={onDone} />
          <TertiaryButton title="Leave it for later" onPress={onLater} />
        </Stack>
      </CenteredBody>
    </Screen>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', width: '100%' },
  centerText: { textAlign: 'center' },
});
