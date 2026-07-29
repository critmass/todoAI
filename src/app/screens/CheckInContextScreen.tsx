// Task 24 — check-in step 3 of 3. Unlike energy/duration this is a real multi-select (`selected`
// is state the controller owns), and it doubles as the "you're back after a crash" re-check when
// `resuming` is true — same screen, warmer copy, because energy/duration are already known then.

import { StyleSheet, View } from 'react-native';

import {
  Caption,
  Heading,
  PrimaryButton,
  Row,
  Screen,
  ScreenHeader,
  ScrollBody,
  SelectChip,
  Stack,
} from '../components';
import { spacing } from '../theme';
import type { CheckInContextProps } from './contracts';

export default function CheckInContextScreen({
  known,
  selected,
  onToggle,
  onDone,
  onBack,
  resuming,
}: CheckInContextProps) {
  return (
    <Screen>
      <ScreenHeader title="Check in" onBack={onBack} />
      <ScrollBody>
        <Stack gap={spacing.lg}>
          <View style={styles.center}>
            <Heading>{resuming ? "You're back. Where are you now?" : 'Where are you right now?'}</Heading>
          </View>

          {resuming ? (
            <Caption style={styles.centerText}>
              Your work was kept while you were away — nothing to redo. Just tell us where you are now.
            </Caption>
          ) : null}

          {known.length === 0 ? (
            <Caption style={styles.centerText}>
              None of your tasks are tagged to a place yet — Start will work fine anyway.
            </Caption>
          ) : (
            <Row>
              {known.map((context) => (
                <SelectChip
                  key={context}
                  label={context}
                  selected={selected.includes(context)}
                  onPress={() => onToggle(context)}
                />
              ))}
            </Row>
          )}

          <PrimaryButton title="Start" onPress={onDone} />
        </Stack>
      </ScrollBody>
    </Screen>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', width: '100%' },
  centerText: { textAlign: 'center' },
});
