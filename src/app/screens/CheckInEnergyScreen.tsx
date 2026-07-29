// Task 24 — check-in step 1 of 3 (spec §6.2: energy → duration → context). One-shot selection:
// pressing an option both answers the question and advances, so there is no persisted "selected"
// state to render here (contrast CheckInContextScreen, which is a real multi-select).

import { StyleSheet, View } from 'react-native';

import { CenteredBody, Heading, Screen, ScreenHeader, SecondaryButton, Stack } from '../components';
import type { UserEnergy } from '../session/types';
import type { CheckInEnergyProps } from './contracts';

const ENERGY_OPTIONS: ReadonlyArray<{ label: string; value: UserEnergy }> = [
  { label: 'Low', value: 'low' },
  { label: 'Medium', value: 'med' },
  { label: 'High', value: 'high' },
];

export default function CheckInEnergyScreen({ onSelect, onBack }: CheckInEnergyProps) {
  return (
    <Screen>
      <ScreenHeader title="Check in" onBack={onBack} />
      <CenteredBody>
        <View style={styles.center}>
          <Heading>How's your energy right now?</Heading>
        </View>
        <Stack>
          {ENERGY_OPTIONS.map((option) => (
            <SecondaryButton key={option.value} title={option.label} onPress={() => onSelect(option.value)} />
          ))}
        </Stack>
      </CenteredBody>
    </Screen>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', width: '100%' },
});
