// Task 24 — metrics, minimal for the personal ship: two live counts plus the last 30 days of
// session performance, grouped by session type. Nulls (not enough data yet for an average) render
// as "—" rather than 0, which would read as a real, bad number.

import { StyleSheet, View } from 'react-native';
import { Body, Card, Caption, Screen, ScreenHeader, ScrollBody, Stack, StatRow } from '../components';
import { spacing } from '../theme';
import type { SessionPerformanceStats } from '../../types/domain';
import type { MetricsProps } from './contracts';

const SESSION_TYPE_LABEL: Record<SessionPerformanceStats['sessionType'], string> = {
  quick: 'Quick sessions',
  moderate: 'Moderate sessions',
  deep_focus: 'Deep focus sessions',
};

function minutes(value: number | null): string {
  return value == null ? '—' : `${Math.round(value)} min`;
}

function percent(value: number | null): string {
  return value == null ? '—' : `${Math.round(value * 100)}%`;
}

export default function MetricsScreen({ activeTaskCount, inProgressCount, performance, onBack }: MetricsProps) {
  return (
    <Screen>
      <ScreenHeader title="Metrics" onBack={onBack} />
      <ScrollBody>
        <Stack gap={spacing.sm}>
          <StatRow label="Active tasks" value={String(activeTaskCount)} />
          <StatRow label="In progress" value={String(inProgressCount)} />
        </Stack>

        {performance.length === 0 ? (
          <Caption>Nothing to show yet — this fills in once you've run a few sessions.</Caption>
        ) : (
          <Stack gap={spacing.sm}>
            {performance.map((entry) => (
              <Card key={entry.sessionType}>
                <Body style={styles.cardTitle}>{SESSION_TYPE_LABEL[entry.sessionType]}</Body>
                <View style={styles.metricRow}>
                  <Caption>Sessions</Caption>
                  <Body>{String(entry.sessionCount)}</Body>
                </View>
                <View style={styles.metricRow}>
                  <Caption>Average duration</Caption>
                  <Body>{minutes(entry.avgDuration)}</Body>
                </View>
                <View style={styles.metricRow}>
                  <Caption>Completion rate</Caption>
                  <Body>{percent(entry.completionRate)}</Body>
                </View>
              </Card>
            ))}
          </Stack>
        )}
      </ScrollBody>
    </Screen>
  );
}

const styles = StyleSheet.create({
  cardTitle: { fontWeight: '600' },
  metricRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
});
