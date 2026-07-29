// Task 24 — spec §6.2's tools checklist, asked once per task immediately before its block starts.
// "Not with me" is framed as the app having picked wrong, not the user falling short — the label
// itself carries that, so the screen just needs to render it as an equal, unashamed option.

import { StyleSheet, View } from 'react-native';

import { Body, Card, Heading, PrimaryButton, Screen, ScreenHeader, ScrollBody, Stack, TertiaryButton } from '../components';
import { spacing } from '../theme';
import type { ToolsCheckProps } from './contracts';

export default function ToolsCheckScreen({ taskTitle, tools, onConfirm, onMissing, onBack }: ToolsCheckProps) {
  return (
    <Screen>
      <ScreenHeader title="Tools check" onBack={onBack} />
      <ScrollBody>
        <Stack gap={spacing.lg}>
          <View style={styles.center}>
            <Heading>{taskTitle}</Heading>
          </View>
          <View style={styles.center}>
            <Body>This task needs:</Body>
          </View>

          <Stack gap={spacing.sm}>
            {tools.map((tool) => (
              <Card key={tool}>
                <Body>{tool}</Body>
              </Card>
            ))}
          </Stack>

          <View style={styles.center}>
            <Body>Do you have all of these with you?</Body>
          </View>

          <Stack gap={spacing.md}>
            <PrimaryButton title="Yes" onPress={onConfirm} />
            <TertiaryButton title="Not with me — pick something else" onPress={onMissing} />
          </Stack>
        </Stack>
      </ScrollBody>
    </Screen>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', width: '100%' },
});
