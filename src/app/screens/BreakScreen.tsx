// Task 24 — a calm, near-empty break screen. No prototype block covers this phase (it's new since
// the prototype was drawn); it's kept deliberately quiet, with nothing urging the user onward.

import { StyleSheet, View } from 'react-native';

import { CenteredBody, Caption, Display, Heading, Screen, TertiaryButton } from '../components';
import type { BreakProps } from './contracts';

export default function BreakScreen({ minutes, display, onContinue }: BreakProps) {
  return (
    <Screen>
      <CenteredBody>
        <View style={styles.center}>
          <Heading>Take five.</Heading>
        </View>
        <View style={styles.center}>
          <Caption style={styles.centerText}>
            {minutes} minute break — no rush, no clock to beat.
          </Caption>
        </View>
        <View style={styles.center}>
          <Display>{display}</Display>
        </View>
        <TertiaryButton title="Start the next task" onPress={onContinue} />
      </CenteredBody>
    </Screen>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', width: '100%' },
  centerText: { textAlign: 'center' },
});
