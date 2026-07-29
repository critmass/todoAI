// Task 24 — the one conversational surface, used for both task capture and coaching (only
// `title` differs; see ../chat/chatController.ts). Bubble radii match the prototype exactly
// (18/18/4/18 for the user, 18/18/18/4 for the coach) since that's an explicit visual spec, not a
// token-table value.
//
// The message input is a plain TextInput rather than the shared `TextField`: the pill shape here
// (matching the prototype's chat input) differs from the form fields' rounded-rect, and — the
// harder constraint — `TextField` has no `editable` prop, so it cannot express "disabled while the
// model is thinking/halted/closed" at all. Disabling here is a real requirement (`status ===
// 'halted'` must not accept further input), not a styling choice, so this is the one screen that
// reaches past the shared vocabulary for its input control.

import { useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Body, Caption, PrimaryButton, Screen, ScreenHeader, SecondaryButton, Stack } from '../components';
import { colors, fontSize, radius, spacing } from '../theme';
import type { ChatProps } from './contracts';

export default function ChatScreen({
  title,
  messages,
  status,
  error,
  canSave,
  canResolve,
  savedTaskTitle,
  resolution,
  onSend,
  onSave,
  onResolve,
  onBack,
}: ChatProps) {
  const [draft, setDraft] = useState('');
  const scrollRef = useRef<ScrollView>(null);
  const disabled = status === 'thinking' || status === 'saving' || status === 'halted' || status === 'closed';

  useEffect(() => {
    scrollRef.current?.scrollToEnd({ animated: true });
  }, [messages.length]);

  function handleSend() {
    const trimmed = draft.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setDraft('');
  }

  return (
    <Screen>
      <ScreenHeader title={title} onBack={onBack} />
      <KeyboardAvoidingView style={styles.flex} behavior="height">
        <ScrollView ref={scrollRef} style={styles.flex} contentContainerStyle={styles.messages}>
          {messages.map((message) => (
            <View key={message.id} style={message.from === 'user' ? styles.userBubble : styles.coachBubble}>
              <Text style={message.from === 'user' ? styles.userBubbleText : styles.coachBubbleText}>
                {message.text}
              </Text>
            </View>
          ))}
        </ScrollView>

        <View style={styles.footer}>
          {status === 'preparing' ? <Caption>Getting the model ready…</Caption> : null}
          {status === 'thinking' ? <Caption>Thinking…</Caption> : null}
          {status === 'saving' ? <Caption>Working on it…</Caption> : null}
          {error ? <Caption>{error}</Caption> : null}

          {savedTaskTitle ? (
            <Stack gap={spacing.sm}>
              <Body>Saved: {savedTaskTitle}.</Body>
              <PrimaryButton title="Done" onPress={onBack} />
            </Stack>
          ) : resolution ? (
            <Stack gap={spacing.sm}>
              <Body>{resolution}</Body>
              <PrimaryButton title="Done" onPress={onBack} />
            </Stack>
          ) : (
            <Stack gap={spacing.sm}>
              {canSave ? <PrimaryButton title="Save this task" onPress={onSave} /> : null}
              {canResolve ? <SecondaryButton title="Wrap this up" onPress={onResolve} /> : null}
            </Stack>
          )}

          <View style={styles.inputRow}>
            <TextInput
              value={draft}
              onChangeText={setDraft}
              onSubmitEditing={handleSend}
              placeholder="Message"
              placeholderTextColor={colors.disabled}
              editable={!disabled}
              style={[styles.inputField, disabled && styles.inputFieldDisabled]}
            />
            <Pressable
              onPress={handleSend}
              disabled={disabled}
              accessibilityRole="button"
              accessibilityLabel="Send"
              style={[styles.sendButton, disabled && styles.sendButtonDisabled]}>
              <Text style={styles.sendButtonLabel}>➤</Text>
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  messages: { padding: spacing.lg, rowGap: spacing.sm },
  userBubble: {
    alignSelf: 'flex-end',
    maxWidth: '78%',
    backgroundColor: colors.text,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    borderBottomRightRadius: 4,
    borderBottomLeftRadius: 18,
  },
  coachBubble: {
    alignSelf: 'flex-start',
    maxWidth: '78%',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    borderBottomRightRadius: 18,
    borderBottomLeftRadius: 4,
  },
  userBubbleText: { color: colors.onPrimary, fontSize: fontSize.body, lineHeight: 20 },
  coachBubbleText: { color: colors.text, fontSize: fontSize.body, lineHeight: 20 },
  footer: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.surface,
    padding: spacing.md,
    rowGap: spacing.sm,
  },
  inputRow: { flexDirection: 'row', alignItems: 'center', columnGap: spacing.sm },
  inputField: {
    flex: 1,
    backgroundColor: colors.background,
    borderWidth: 1,
    borderColor: colors.borderInput,
    borderRadius: radius.pill,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    fontSize: fontSize.input,
    color: colors.text,
  },
  inputFieldDisabled: { opacity: 0.6 },
  sendButton: {
    width: 40,
    height: 40,
    borderRadius: radius.pill,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendButtonDisabled: { opacity: 0.5 },
  sendButtonLabel: { color: colors.onPrimary, fontSize: fontSize.input },
});
