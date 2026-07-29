// Task 24 — spec §8.1/§8.2: the planner found nothing servable. No prototype block covers this
// either. Both outcomes stay in the same register as the rest of the flow: the plan was wrong for
// this moment, not the person, and coaching or a split are offered as the way through, not a fix
// for a failure.

import { StyleSheet, View } from 'react-native';

import { Body, CenteredBody, Heading, PrimaryButton, Screen, ScreenHeader, SecondaryButton, Stack } from '../components';
import { spacing } from '../theme';
import type { PlanEmptyProps } from './contracts';

export default function PlanEmptyScreen({ outcome, splitCandidateTitle, onSplit, onCoach, onBack }: PlanEmptyProps) {
  const isNothingFits = outcome === 'nothing_fits';
  const showSplit = isNothingFits && splitCandidateTitle !== null;

  return (
    <Screen>
      <ScreenHeader title="Check in" onBack={onBack} />
      <CenteredBody>
        <View style={styles.center}>
          <Heading>{isNothingFits ? 'Nothing fits in the time you have.' : 'Nothing fits right now.'}</Heading>
        </View>
        <View style={styles.center}>
          <Body style={styles.centerText}>
            {isNothingFits
              ? "You've got tasks, but none of them fit this stretch of time — the plan was off, not you."
              : 'None of your tasks match this context or energy right now — the plan was off, not you.'}
          </Body>
        </View>
        <Stack gap={spacing.md}>
          {showSplit && splitCandidateTitle ? (
            <PrimaryButton title={`Break "${splitCandidateTitle}" into smaller steps`} onPress={onSplit} />
          ) : null}
          {showSplit ? (
            <SecondaryButton title="Talk it through" onPress={onCoach} />
          ) : (
            <PrimaryButton title="Talk it through" onPress={onCoach} />
          )}
        </Stack>
      </CenteredBody>
    </Screen>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', width: '100%' },
  centerText: { textAlign: 'center' },
});
