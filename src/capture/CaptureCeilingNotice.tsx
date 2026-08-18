// Task 41 — the ceiling warning surface (amendment §5).
//
// IT LIVES IN `src/capture/`, NOT IN `src/app/screens/`, and that is structural rather than
// stylistic: deleting capture must not leave a dangling screen behind. The shell renders it with
// ONE line, so removing capture is removing that line (orientation §5's removability decision, and
// the same property ruling 12.2 was chosen to protect).
//
// 🔴 THIS IS A BLACK-SWAN NET, NOT A WORKFLOW PROMPT. It has no progress bar, no percentage, and
// no recurring nag, because those train the eye to dismiss it and the whole value of this surface
// is that seeing it once means something is badly wrong. See ./retention.ts for the ruling and its
// reasoning. It is also a warning and NOT a block: it renders over whatever is on screen, is
// dismissed with one press, and stops nothing.
//
// It is shown only at APP OPEN or SESSION CLOSE. Never mid-episode — this is an ADHD app and
// capture is not permitted to compete with focus.

import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, fontSize, radius, spacing } from '../app/theme';
import { CAPTURE_CEILING_BYTES, type CaptureCeilingState } from './retention';

function mb(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

export function CaptureCeilingNotice({
  state,
  onDismiss,
}: {
  state: CaptureCeilingState | null;
  onDismiss: () => void;
}) {
  if (!state) return null;
  return (
    <Modal transparent animationType="fade" visible onRequestClose={onDismiss}>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <Text style={styles.title}>Diagnostic logs are nearly full</Text>
          <Text style={styles.body}>
            {mb(state.bytesOnDisk)} of {mb(CAPTURE_CEILING_BYTES)}. This was projected to take about
            five years, so reaching it means something is writing far more than expected. Pull the
            logs to the laptop and look at what.
          </Text>
          {state.rotatedDays.length > 0 ? (
            <Text style={styles.body}>
              Oldest days already deleted to stay under the ceiling:{' '}
              {state.rotatedDays.join(', ')}.
            </Text>
          ) : null}
          <Text style={styles.footnote}>
            Nothing is blocked. Sessions and the app work exactly as before.
          </Text>
          <Pressable style={styles.button} onPress={onDismiss} accessibilityRole="button">
            <Text style={styles.buttonLabel}>Got it</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(27,27,31,0.45)',
    justifyContent: 'center',
    padding: spacing.lg,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.lg,
    gap: spacing.md,
  },
  title: { fontSize: fontSize.title, fontWeight: '700', color: colors.text },
  body: { fontSize: fontSize.body, color: colors.textSecondary },
  footnote: { fontSize: fontSize.caption, color: colors.textMuted },
  button: {
    alignSelf: 'flex-end',
    backgroundColor: colors.primary,
    borderRadius: radius.button,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  buttonLabel: { color: colors.onPrimary, fontWeight: '700' },
});
