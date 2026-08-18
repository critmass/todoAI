// Task 24 — the timer-dominant execution screen (spec §6.2: the timer IS the screen). The circle
// itself is the pause control once a block is running; before that it's a single START button.
// There is no conic-gradient in RN without a new dependency, so progress renders as a plain
// horizontal bar under the circle rather than a hand-rolled arc.
//
// TASK 44 §2 — CORRECTING THE RECORD, NOT THE UI. The line this replaced claimed the bar was
// "explicitly acceptable — preferable, even — per the task brief." Task 24's brief says nothing
// about a bar, dial, arc or conic-gradient at all — there was no such authorization to cite. What
// actually happened: task 23's HTML prototype (`Main Screen.dc.html`) used a conic-gradient dial,
// which React Native cannot render without a new native dependency; task 24 shipped a bar instead
// and recorded the substitution in its own findings report §6 as "deferred to the beta (designed)
// pass — deliberately, not forgotten." Filing a DESIGN CHANGE as a deferral reads as scheduling,
// not as the un-signed-off substitution it was — see `docs/eval/task24_findings_report.md` §6 and
// `docs/briefs/personal_qol_task_44.md` §2 for the full account. The dial itself is UNCHANGED here
// and remains deferred to the designed visual pass (task 45's territory, not this task's) — this
// commit fixes only the false citation, per the brief's explicit instruction: "fix the false
// comment... so it cites the findings report and states plainly that the dial is deferred, not
// rejected."

import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Caption, Display, Eyebrow, PrimaryButton, QuietLink, Screen, ScreenHeader, TertiaryButton } from '../components';
import { colors, fontSize, radius, shadow, spacing } from '../theme';
import type { WorkProps } from './contracts';

export default function WorkScreen({
  taskTitle,
  resumed,
  easierNote,
  timer,
  display,
  progress,
  onStart,
  onTogglePause,
  onEndBlock,
  onSomethingEasier,
  onNotThisOne,
  onBack,
}: WorkProps) {
  const paused = timer?.paused ?? false;
  const statusLabel = paused ? 'Paused' : timer?.face === 'countup' ? 'In flow' : 'Focusing';
  const clampedProgress = Math.max(0, Math.min(1, progress));

  return (
    <Screen>
      <ScreenHeader title="Focus" onBack={onBack} />
      <View style={styles.body}>
        <View style={styles.top}>
          <Eyebrow>Now working on</Eyebrow>
          <Display>{taskTitle}</Display>
          {resumed ? <Caption style={styles.resumedLabel}>Picking this back up</Caption> : null}
          {easierNote ? <Caption style={styles.centerText}>{easierNote}</Caption> : null}
        </View>

        <View style={styles.middle}>
          {timer === null ? (
            <Pressable
              onPress={onStart}
              accessibilityRole="button"
              accessibilityLabel="Start"
              style={[styles.circle, styles.circleActive]}>
              <Text style={styles.startLabel}>START</Text>
            </Pressable>
          ) : (
            <View style={styles.timerBlock}>
              <Pressable
                onPress={onTogglePause}
                accessibilityRole="button"
                accessibilityLabel={paused ? 'Resume' : 'Pause'}
                style={[styles.circle, paused ? styles.circlePaused : styles.circleActive]}>
                <Text style={styles.timeLabel}>{display}</Text>
                <Text style={styles.statusLabel}>{statusLabel}</Text>
              </Pressable>
              <View style={styles.progressTrack}>
                <View style={[styles.progressFill, { width: `${clampedProgress * 100}%` }]} />
              </View>
            </View>
          )}
        </View>

        <View style={styles.bottom}>
          {timer === null ? (
            <TertiaryButton title="Not this one" onPress={onNotThisOne} />
          ) : (
            <PrimaryButton title="End this block" onPress={onEndBlock} />
          )}
          <QuietLink title="This isn't landing → give me something easier" onPress={onSomethingEasier} />
        </View>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: {
    flex: 1,
    paddingHorizontal: spacing.xxl,
    paddingTop: spacing.xl,
    paddingBottom: spacing.xl,
    rowGap: spacing.lg,
  },
  top: { alignItems: 'center', rowGap: spacing.sm },
  middle: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  bottom: { width: '100%', alignItems: 'center', rowGap: spacing.md },
  resumedLabel: { color: colors.primary, fontWeight: '600' },
  centerText: { textAlign: 'center' },
  timerBlock: { alignItems: 'center', rowGap: spacing.lg },
  circle: {
    width: 160,
    height: 160,
    borderRadius: 80,
    alignItems: 'center',
    justifyContent: 'center',
    rowGap: spacing.xs,
    ...shadow.timer,
  },
  circleActive: { backgroundColor: colors.primary },
  circlePaused: { backgroundColor: colors.paused },
  startLabel: { color: colors.onPrimary, fontSize: fontSize.heading, fontWeight: '700', letterSpacing: 1 },
  timeLabel: { color: colors.onPrimary, fontSize: fontSize.timer, fontWeight: '700' },
  statusLabel: {
    color: colors.onPrimary,
    fontSize: fontSize.small,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    opacity: 0.85,
  },
  progressTrack: {
    width: 160,
    height: 6,
    borderRadius: radius.pill,
    backgroundColor: colors.border,
    overflow: 'hidden',
  },
  progressFill: { height: '100%', borderRadius: radius.pill, backgroundColor: colors.primary },
});
