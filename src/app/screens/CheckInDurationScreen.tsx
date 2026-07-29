// Task 24 — check-in step 2 of 3. `choices` is handed to us already built (DURATION_CHOICES); we
// just render each one's label and hand the whole choice back on press.

import { StyleSheet, View } from 'react-native';

import { CenteredBody, Heading, Screen, ScreenHeader, SecondaryButton, Stack } from '../components';
import type { CheckInDurationProps } from './contracts';

export default function CheckInDurationScreen({ choices, onSelect, onBack }: CheckInDurationProps) {
  return (
    <Screen>
      <ScreenHeader title="Check in" onBack={onBack} />
      <CenteredBody>
        <View style={styles.center}>
          <Heading>How much time do you have?</Heading>
        </View>
        <Stack>
          {choices.map((choice) => (
            <SecondaryButton key={choice.label} title={choice.label} onPress={() => onSelect(choice)} />
          ))}
        </Stack>
      </CenteredBody>
    </Screen>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', width: '100%' },
});
