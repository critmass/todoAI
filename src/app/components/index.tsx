// Task 24 — the shared presentational vocabulary every screen is built from. Deliberately tiny:
// a screen frame, a header, four button weights, two chip shapes, a card and a text field. The
// prototype's whole visual system is expressible in these, and keeping the set small is what
// stops the functional pass from drifting into the beta-gate designed pass.
//
// Everything here is presentational. No repository, no service, no clock. `Dropdown` holds the one
// piece of local state in the file — whether its own menu is open, which is not application state
// and has no business in a draft.

import { useState, type ReactNode } from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, fontSize, radius, shadow, spacing } from '../theme';

// ── Frame ────────────────────────────────────────────────────────────────────────────────────

export function Screen({ children }: { children: ReactNode }) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.screen, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      {children}
    </View>
  );
}

/** The body of a screen whose content is short and should sit centred (dashboard, check-in). */
export function CenteredBody({ children }: { children: ReactNode }) {
  return <View style={styles.centeredBody}>{children}</View>;
}

/** The body of a screen whose content can overflow (task list, editor, chat). */
export function ScrollBody({ children }: { children: ReactNode }) {
  return (
    <ScrollView style={styles.scrollBody} contentContainerStyle={styles.scrollBodyContent}>
      {children}
    </ScrollView>
  );
}

export function ScreenHeader({ title, onBack }: { title: string; onBack?: () => void }) {
  return (
    <View style={styles.header}>
      {onBack ? (
        <Pressable onPress={onBack} hitSlop={12} accessibilityRole="button" accessibilityLabel="Back">
          <Text style={styles.headerBack}>←</Text>
        </Pressable>
      ) : null}
      <Text style={styles.headerTitle}>{title}</Text>
    </View>
  );
}

// ── Type ─────────────────────────────────────────────────────────────────────────────────────

export function Heading({ children }: { children: ReactNode }) {
  return <Text style={styles.heading}>{children}</Text>;
}

export function Display({ children }: { children: ReactNode }) {
  return <Text style={styles.display}>{children}</Text>;
}

export function Body({ children, style }: { children: ReactNode; style?: StyleProp<TextStyle> }) {
  return <Text style={[styles.body, style]}>{children}</Text>;
}

export function Caption({ children, style }: { children: ReactNode; style?: StyleProp<TextStyle> }) {
  return <Text style={[styles.caption, style]}>{children}</Text>;
}

export function Label({ children }: { children: ReactNode }) {
  return <Text style={styles.label}>{children}</Text>;
}

/** The small all-caps eyebrow above a task title ("NOW WORKING ON", "BLOCK ENDED"). */
export function Eyebrow({ children }: { children: ReactNode }) {
  return <Text style={styles.eyebrow}>{children}</Text>;
}

// ── Buttons ──────────────────────────────────────────────────────────────────────────────────

interface ButtonProps {
  title: string;
  onPress: () => void;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
}

/** The affirmative action. One per screen — more than one is a decision the user didn't ask for. */
export function PrimaryButton({ title, onPress, disabled, style }: ButtonProps) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      style={({ pressed }) => [
        styles.buttonBase,
        styles.primaryButton,
        pressed && styles.primaryButtonPressed,
        disabled && styles.buttonDisabled,
        style,
      ]}>
      <Text style={styles.primaryLabel}>{title}</Text>
    </Pressable>
  );
}

/** An equal-weight alternative (the two extends). Outlined in the accent, not filled. */
export function SecondaryButton({ title, onPress, disabled, style }: ButtonProps) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      style={({ pressed }) => [
        styles.buttonBase,
        styles.secondaryButton,
        pressed && styles.secondaryButtonPressed,
        disabled && styles.buttonDisabled,
        style,
      ]}>
      <Text style={styles.secondaryLabel}>{title}</Text>
    </Pressable>
  );
}

/** A quieter option (park, skip, something easier). Grey outline — available, not urged. */
export function TertiaryButton({ title, onPress, disabled, style }: ButtonProps) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      style={({ pressed }) => [
        styles.buttonBase,
        styles.tertiaryButton,
        pressed && styles.tertiaryButtonPressed,
        disabled && styles.buttonDisabled,
        style,
      ]}>
      <Text style={styles.tertiaryLabel}>{title}</Text>
    </Pressable>
  );
}

/** The escape valve's weight: underlined text, always present, never shouting (design principle
 *  #2 — a graceful way out is always visible but never the loudest thing on the screen). */
export function QuietLink({ title, onPress }: { title: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} hitSlop={8} accessibilityRole="button">
      <Text style={styles.quietLink}>{title}</Text>
    </Pressable>
  );
}

export function DangerButton({ title, onPress, disabled, style }: ButtonProps) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      style={({ pressed }) => [
        styles.buttonBase,
        styles.dangerButton,
        disabled && styles.dangerButtonDisabled,
        pressed && !disabled && styles.tertiaryButtonPressed,
        style,
      ]}>
      <Text style={[styles.dangerLabel, disabled && styles.dangerLabelDisabled]}>{title}</Text>
    </Pressable>
  );
}

// ── Chips, cards, fields ─────────────────────────────────────────────────────────────────────

/** A single-select / multi-select pill (weekdays, periods, contexts) — and, sized down by `style`,
 *  one box of the recurrence editor's two grids. `accessibilityLabel` is what makes that second use
 *  legitimate: a grid cell's own text is a tick or a bare number, and "1st Monday" is the only
 *  thing that says what tapping it means. */
export function SelectChip({
  label,
  selected,
  onPress,
  style,
  accessibilityLabel,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
  style?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ selected }}
      style={[styles.chip, selected ? styles.chipSelected : styles.chipUnselected, style]}>
      <Text style={selected ? styles.chipLabelSelected : styles.chipLabel}>{label}</Text>
    </Pressable>
  );
}

/**
 * A single-select menu: the current choice on one line, the whole list in a sheet.
 *
 * 🔴 JS ONLY, deliberately. `@react-native-picker/picker` — or any other native picker — would be a
 * new native module, and therefore a full rebuild and another run at this project's documented
 * `.cxx` codegen trap (task 24 §9.6). A `Pressable` plus React Native's own core `Modal` needs
 * none of that: no native code, no rebuild, and the whole control is testable headless.
 *
 * Reusable on purpose. Several screens are chip rows that could adopt it later; nothing else does
 * yet, and converting them is not this task.
 */
export function Dropdown<T extends string>({
  value,
  options,
  onSelect,
  accessibilityLabel,
}: {
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onSelect: (next: T) => void;
  /** What the closed control is called ("How often this repeats"). The visible text is the
   *  CURRENT VALUE, which on its own never says what the value is a value of. */
  accessibilityLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const current = options.find((option) => option.value === value);
  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        accessibilityState={{ expanded: open }}
        style={({ pressed }) => [styles.dropdown, pressed && styles.dropdownPressed]}>
        <Text style={styles.dropdownValue}>{current ? current.label : ''}</Text>
        <Text style={styles.dropdownCaret}>▾</Text>
      </Pressable>
      {open ? (
        <Modal transparent visible animationType="fade" onRequestClose={() => setOpen(false)}>
          <View style={styles.menuOverlay}>
            {/* A full-screen sibling rather than a wrapper, so a tap on an option is never also a
                tap on the backdrop. */}
            <Pressable
              onPress={() => setOpen(false)}
              accessibilityRole="button"
              accessibilityLabel="Close menu"
              style={styles.menuBackdrop}
            />
            <ScrollView style={styles.menuSheet}>
              {options.map((option) => (
                <Pressable
                  key={option.value}
                  onPress={() => {
                    setOpen(false);
                    onSelect(option.value);
                  }}
                  accessibilityRole="button"
                  accessibilityLabel={option.label}
                  accessibilityState={{ selected: option.value === value }}
                  style={({ pressed }) => [styles.menuItem, pressed && styles.dropdownPressed]}>
                  <Text
                    style={option.value === value ? styles.menuItemSelected : styles.menuItemLabel}>
                    {option.label}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
          </View>
        </Modal>
      ) : null}
    </>
  );
}

/** A value the user has added and can take back off (tools, context tags). */
export function RemovableChip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <View style={styles.removableChip}>
      <Text style={styles.chipLabel}>{label}</Text>
      <Pressable
        onPress={onRemove}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={`Remove ${label}`}>
        <Text style={styles.removableChipX}>×</Text>
      </Pressable>
    </View>
  );
}

export function Card({ children, onPress }: { children: ReactNode; onPress?: () => void }) {
  if (!onPress) return <View style={styles.card}>{children}</View>;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}>
      {children}
    </Pressable>
  );
}

/** A label/value row in the session summary and metrics. */
export function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.statRow}>
      <Text style={styles.body}>{label}</Text>
      <Text style={styles.statValue}>{value}</Text>
    </View>
  );
}

export function TextField({
  value,
  onChangeText,
  placeholder,
  keyboardType,
  onSubmitEditing,
  style,
}: {
  value: string;
  onChangeText: (next: string) => void;
  placeholder?: string;
  keyboardType?: 'default' | 'number-pad';
  onSubmitEditing?: () => void;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <TextInput
      value={value}
      onChangeText={onChangeText}
      placeholder={placeholder}
      placeholderTextColor={colors.disabled}
      keyboardType={keyboardType}
      onSubmitEditing={onSubmitEditing}
      style={[styles.textField, style]}
    />
  );
}

/** Vertical rhythm between stacked controls, so screens don't each invent their own gap. */
export function Stack({ children, gap = spacing.md }: { children: ReactNode; gap?: number }) {
  return <View style={[styles.stack, { rowGap: gap }]}>{children}</View>;
}

export function Row({ children, gap = spacing.sm }: { children: ReactNode; gap?: number }) {
  return <View style={[styles.row, { columnGap: gap, rowGap: gap }]}>{children}</View>;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  centeredBody: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: spacing.xxl,
    paddingVertical: spacing.xl,
    rowGap: spacing.lg,
  },
  scrollBody: { flex: 1 },
  scrollBodyContent: { padding: spacing.lg, rowGap: spacing.md },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    columnGap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.surface,
  },
  headerBack: { fontSize: fontSize.heading, color: colors.text },
  headerTitle: { fontSize: fontSize.title, fontWeight: '600', color: colors.text },

  display: { fontSize: fontSize.display, fontWeight: '600', color: colors.text, textAlign: 'center' },
  heading: { fontSize: fontSize.heading, fontWeight: '600', color: colors.text },
  body: { fontSize: fontSize.body, color: colors.text },
  caption: { fontSize: fontSize.caption, color: colors.textMuted, lineHeight: 18 },
  label: { fontSize: fontSize.caption, fontWeight: '600', color: colors.textMuted },
  eyebrow: {
    fontSize: fontSize.small,
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },

  buttonBase: {
    width: '100%',
    paddingVertical: spacing.lg,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.buttonLarge,
    alignItems: 'center',
  },
  buttonDisabled: { opacity: 0.5 },
  primaryButton: { backgroundColor: colors.primary, ...shadow.button },
  primaryButtonPressed: { backgroundColor: colors.primaryPressed },
  primaryLabel: { color: colors.onPrimary, fontSize: fontSize.input, fontWeight: '600' },
  secondaryButton: { borderWidth: 1.5, borderColor: colors.primary },
  secondaryButtonPressed: { backgroundColor: colors.border },
  secondaryLabel: { color: colors.primary, fontSize: fontSize.input, fontWeight: '600' },
  tertiaryButton: { borderWidth: 1, borderColor: colors.borderMuted },
  tertiaryButtonPressed: { backgroundColor: colors.border },
  tertiaryLabel: { color: colors.textSecondary, fontSize: fontSize.input, fontWeight: '500' },
  dangerButton: { borderWidth: 1, borderColor: colors.danger },
  dangerButtonDisabled: { borderColor: colors.border },
  dangerLabel: { color: colors.danger, fontSize: fontSize.input, fontWeight: '600' },
  dangerLabelDisabled: { color: colors.disabled },
  quietLink: {
    color: colors.textMuted,
    fontSize: fontSize.caption,
    fontWeight: '500',
    textDecorationLine: 'underline',
    textAlign: 'center',
    paddingVertical: spacing.xs,
  },

  chip: { paddingVertical: 9, paddingHorizontal: spacing.md, borderRadius: radius.pill },
  chipSelected: { backgroundColor: colors.primary, borderWidth: 1.5, borderColor: colors.primary },
  chipUnselected: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  chipLabel: { fontSize: fontSize.small, fontWeight: '600', color: colors.textSecondary },
  chipLabelSelected: { fontSize: fontSize.small, fontWeight: '600', color: colors.onPrimary },
  removableChip: {
    flexDirection: 'row',
    alignItems: 'center',
    columnGap: spacing.sm,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.pill,
    paddingVertical: spacing.sm,
    paddingLeft: spacing.md,
    paddingRight: spacing.sm,
  },
  removableChipX: { color: colors.textMuted, fontSize: fontSize.input },

  dropdown: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    columnGap: spacing.sm,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.borderInput,
    borderRadius: radius.sm,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
  },
  dropdownPressed: { backgroundColor: colors.border },
  dropdownValue: { fontSize: fontSize.input, color: colors.text, fontWeight: '500' },
  dropdownCaret: { fontSize: fontSize.input, color: colors.textMuted },
  menuOverlay: { flex: 1, justifyContent: 'center', padding: spacing.xl },
  menuBackdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: '#00000055',
  },
  menuSheet: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    maxHeight: '80%',
    ...shadow.button,
  },
  menuItem: { paddingVertical: spacing.lg, paddingHorizontal: spacing.lg },
  menuItemLabel: { fontSize: fontSize.input, color: colors.text },
  menuItemSelected: { fontSize: fontSize.input, color: colors.primary, fontWeight: '600' },

  card: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.lg,
    rowGap: spacing.xs,
  },
  cardPressed: { backgroundColor: colors.border },
  statRow: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  statValue: { fontSize: fontSize.body, fontWeight: '600', color: colors.primary },

  textField: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.borderInput,
    borderRadius: radius.sm,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    fontSize: fontSize.input,
    color: colors.text,
  },

  stack: { width: '100%' },
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center' },
});
