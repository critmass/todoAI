// Task 24 — the task editor. Renders exactly `TaskDraft` (see ../tasks/taskDraft.ts): every field
// here is a direct patch onto the draft, and Save is disabled until `validateDraft` is clean.
// Delete is dependency-protected — the screen shows the reason rather than hiding the control.

import { useState } from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';
import {
  Body,
  Caption,
  DangerButton,
  Label,
  PrimaryButton,
  RemovableChip,
  Row,
  Screen,
  ScreenHeader,
  ScrollBody,
  SelectChip,
  Stack,
  TextField,
} from '../components';
import { colors, fontSize, radius, spacing } from '../theme';
import type { TaskEditorProps } from './contracts';
import { RecurrenceEditor } from './RecurrenceEditor';

export default function TaskEditorScreen({
  draft,
  validation,
  onChange,
  onSave,
  onDelete,
  canDelete,
  saving,
  onBack,
}: TaskEditorProps) {
  const [newTool, setNewTool] = useState('');
  const [newContext, setNewContext] = useState('');

  function addTool() {
    const value = newTool.trim();
    if (!value) return;
    onChange({ toolRequirements: [...draft.toolRequirements, value] });
    setNewTool('');
  }
  function removeTool(index: number) {
    onChange({ toolRequirements: draft.toolRequirements.filter((_, i) => i !== index) });
  }

  function addContext() {
    const value = newContext.trim();
    if (!value) return;
    onChange({ contextTags: [...draft.contextTags, value] });
    setNewContext('');
  }
  function removeContext(index: number) {
    onChange({ contextTags: draft.contextTags.filter((_, i) => i !== index) });
  }

  const saveDisabled = saving || Object.keys(validation.errors).length > 0;

  return (
    <Screen>
      <ScreenHeader title="Edit task" onBack={onBack} />
      <ScrollBody>
        <Stack gap={spacing.xl}>
          <Stack gap={spacing.sm}>
            <Label>Task name</Label>
            <TextField value={draft.title} onChangeText={(title) => onChange({ title })} />
            {validation.errors.title ? (
              <Caption style={styles.errorText}>{validation.errors.title}</Caption>
            ) : null}
          </Stack>

          <Stack gap={spacing.sm}>
            <Label>Notes</Label>
            <TextField value={draft.description} onChangeText={(description) => onChange({ description })} />
          </Stack>

          <Stack gap={spacing.sm}>
            <Label>How long</Label>
            <Row>
              <TextField
                value={draft.estimatedDuration}
                onChangeText={(estimatedDuration) => onChange({ estimatedDuration })}
                keyboardType="number-pad"
                style={styles.durationField}
              />
              <Body>minutes</Body>
            </Row>
            {validation.errors.estimatedDuration ? (
              <Caption style={styles.errorText}>{validation.errors.estimatedDuration}</Caption>
            ) : null}
            <Row>
              <SelectChip
                label="Takes about this long"
                selected={!draft.openEnded}
                onPress={() => onChange({ openEnded: false })}
              />
              <SelectChip
                label="At least this long"
                selected={draft.openEnded}
                onPress={() => onChange({ openEnded: true })}
              />
            </Row>
            {draft.openEnded ? (
              <Caption>The timer counts up while you work, so there's no overrun to worry about.</Caption>
            ) : null}
          </Stack>

          <Stack gap={spacing.sm}>
            <Label>Energy it takes</Label>
            <Row>
              <SelectChip label="Low" selected={draft.energy === 'low'} onPress={() => onChange({ energy: 'low' })} />
              <SelectChip
                label="Medium"
                selected={draft.energy === 'med'}
                onPress={() => onChange({ energy: 'med' })}
              />
              <SelectChip
                label="High"
                selected={draft.energy === 'high'}
                onPress={() => onChange({ energy: 'high' })}
              />
            </Row>
          </Stack>

          <Stack gap={spacing.sm}>
            <Label>How often</Label>
            <RecurrenceEditor draft={draft} onChange={onChange} validation={validation} />
          </Stack>

          <Stack gap={spacing.sm}>
            <Label>Tools required</Label>
            <Row>
              {draft.toolRequirements.map((tool, index) => (
                <RemovableChip key={`${tool}-${index}`} label={tool} onRemove={() => removeTool(index)} />
              ))}
            </Row>
            <Row>
              <TextField
                value={newTool}
                onChangeText={setNewTool}
                placeholder="Add a tool…"
                onSubmitEditing={addTool}
                style={styles.flexField}
              />
              <Pressable onPress={addTool} accessibilityRole="button" style={styles.addButton}>
                <Text style={styles.addButtonLabel}>Add</Text>
              </Pressable>
            </Row>
          </Stack>

          <Stack gap={spacing.sm}>
            <Label>Contexts this task is in</Label>
            <Row>
              {draft.contextTags.map((tag, index) => (
                <RemovableChip key={`${tag}-${index}`} label={tag} onRemove={() => removeContext(index)} />
              ))}
            </Row>
            <Row>
              <TextField
                value={newContext}
                onChangeText={setNewContext}
                placeholder="Add a context…"
                onSubmitEditing={addContext}
                style={styles.flexField}
              />
              <Pressable onPress={addContext} accessibilityRole="button" style={styles.addButton}>
                <Text style={styles.addButtonLabel}>Add</Text>
              </Pressable>
            </Row>
          </Stack>

          <Stack gap={spacing.md}>
            <PrimaryButton title="Save" onPress={onSave} disabled={saveDisabled} />
            {!canDelete ? (
              <Caption style={styles.centeredCaption}>
                Other tasks depend on this one, so it can't be deleted.
              </Caption>
            ) : null}
            <DangerButton title="Delete task" onPress={onDelete} disabled={!canDelete} />
          </Stack>
        </Stack>
      </ScrollBody>
    </Screen>
  );
}

// The shared button vocabulary (Primary/Secondary/Tertiary) is always full-width, by design — none
// of it fits an inline "Add" action beside a text field, so this one small pill is bespoke.
const styles = StyleSheet.create({
  errorText: { color: colors.danger },
  centeredCaption: { textAlign: 'center' },
  durationField: { width: 80, textAlign: 'center' },
  flexField: { flex: 1 },
  addButton: {
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.sm,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  addButtonLabel: { color: colors.onPrimary, fontSize: fontSize.small, fontWeight: '600' },
});
