// Task 24 — the session close-out. Stat rows first, then spec §6.2's end-of-session energy check
// (optional, never blocking), then the two non-blocking asides (revisit-estimate, lapsed), then a
// closing line whose tone depends only on whether anything got finished — never on what didn't.

import { StyleSheet, View } from 'react-native';

import {
  Body,
  Caption,
  Heading,
  PrimaryButton,
  QuietLink,
  Row,
  Screen,
  ScrollBody,
  SelectChip,
  Stack,
  StatRow,
} from '../components';
import { spacing } from '../theme';
import type { UserEnergy } from '../session/types';
import type { SessionSummaryProps } from './contracts';

const ENERGY_OPTIONS: ReadonlyArray<{ label: string; value: UserEnergy }> = [
  { label: 'Low', value: 'low' },
  { label: 'Medium', value: 'med' },
  { label: 'High', value: 'high' },
];

export default function SessionSummaryScreen({
  summary,
  energy,
  onEnergy,
  onRevisitEstimate,
  onDone,
}: SessionSummaryProps) {
  const showRevisit = summary.ranLongTitles.length > 0 && onRevisitEstimate !== null;

  return (
    <Screen>
      <ScrollBody>
        <Stack gap={spacing.lg}>
          <View style={styles.center}>
            <Heading>That's the session</Heading>
          </View>

          <Stack gap={spacing.sm}>
            <StatRow label="Finished" value={String(summary.completed)} />
            <StatRow label="Paused for later" value={String(summary.parked)} />
            <StatRow label="Set aside" value={String(summary.skipped)} />
          </Stack>

          <Stack gap={spacing.sm}>
            <View style={styles.center}>
              <Body>How's your energy now?</Body>
            </View>
            <Row>
              {ENERGY_OPTIONS.map((option) => (
                <SelectChip
                  key={option.value}
                  label={option.label}
                  selected={energy === option.value}
                  onPress={() => onEnergy(option.value)}
                />
              ))}
            </Row>
          </Stack>

          {showRevisit && onRevisitEstimate ? (
            <QuietLink
              title={`"${summary.ranLongTitles[0]}" ran long a few times — want to revisit its estimate?`}
              onPress={onRevisitEstimate}
            />
          ) : null}

          {summary.lapsed ? <Caption style={styles.centerText}>This session's time ran out.</Caption> : null}

          <Caption style={styles.centerText}>
            {summary.completed > 0
              ? 'Everything paused keeps its progress and comes back next session.'
              : 'Nothing landed this time — that means the plan was off, not you.'}
          </Caption>

          <PrimaryButton title="Back to start" onPress={onDone} />
        </Stack>
      </ScrollBody>
    </Screen>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', width: '100%' },
  centerText: { textAlign: 'center' },
});
