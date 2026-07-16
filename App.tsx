/**
 * Sample React Native App
 * https://github.com/facebook/react-native
 *
 * @format
 */

import { useState } from 'react';
import { Button, StatusBar, StyleSheet, useColorScheme, View } from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
// TEMPORARY swap for the Q1 grammar smoke test (docs/briefs/Q1_grammar_smoke_test_brief.md) —
// revert to NewAppScreen once Q1 is done. See src/dev/Q1GrammarSpikeScreen.tsx.
import Q1GrammarSpikeScreen from './src/dev/Q1GrammarSpikeScreen';
// Q1b follow-on: date_str isolation probes (docs/briefs/Q1b_bounded_integer_probe_brief.md),
// split into its own screen to keep Q1GrammarSpikeScreen navigable. See
// src/dev/DateStrProbeScreen.tsx.
import DateStrProbeScreen from './src/dev/DateStrProbeScreen';
// Q1c: reopens Q1b's "rule name must match its JSON key" conclusion - the underscore-vs-
// key-matching confound (docs/briefs/Q1c_rule_name_disambiguation_brief.md). See
// src/dev/RuleNameProbeScreen.tsx.
import RuleNameProbeScreen from './src/dev/RuleNameProbeScreen';
// Phase B: Task 6 on-device confirmation, driving the REAL TernaryBonsaiProvider + ladder +
// startup guard (docs/briefs/opus_batch_B_device.md). See src/dev/Task6DeviceScreen.tsx.
import Task6DeviceScreen from './src/dev/Task6DeviceScreen';
// Phase B: Task 7 prompt-tuning loop, driving the REAL task-7 prompts and scoring
// valid-AND-correct against each fixture's gold. See src/dev/Task7PromptScreen.tsx.
import Task7PromptScreen from './src/dev/Task7PromptScreen';
// Phase B: Task 12 on-device — the DB de-risk spike, the three triggers, and real dispatch
// through real repositories. See src/dev/Task12DeviceScreen.tsx.
import Task12DeviceScreen from './src/dev/Task12DeviceScreen';

function App() {
  const isDarkMode = useColorScheme() === 'dark';

  return (
    <SafeAreaProvider>
      <StatusBar barStyle={isDarkMode ? 'light-content' : 'dark-content'} />
      <AppContent />
    </SafeAreaProvider>
  );
}

function AppContent() {
  const [screen, setScreen] = useState<'task12' | 'task7' | 'task6' | 'q1' | 'dateStr' | 'ruleName'>('task12');
  // Bug fixed live (2026-07-13): this switcher was rendering under the status bar with no
  // top inset - the "date_str Probes" button was visible on-screen but its taps were being
  // intercepted by the status bar area instead of reaching the Button, so switching never
  // fired. useSafeAreaInsets pushes it below the status bar/notch.
  const insets = useSafeAreaInsets();

  return (
    <View style={styles.container}>
      <View style={[styles.switcher, { paddingTop: insets.top + 8 }]}>
        <Button title="Task 12" onPress={() => setScreen('task12')} disabled={screen === 'task12'} />
        <Button title="Task 7" onPress={() => setScreen('task7')} disabled={screen === 'task7'} />
        <Button title="Task 6" onPress={() => setScreen('task6')} disabled={screen === 'task6'} />
        <Button title="Q1" onPress={() => setScreen('q1')} disabled={screen === 'q1'} />
        <Button
          title="date_str Probes"
          onPress={() => setScreen('dateStr')}
          disabled={screen === 'dateStr'}
        />
        <Button
          title="Rule Name Probes"
          onPress={() => setScreen('ruleName')}
          disabled={screen === 'ruleName'}
        />
      </View>
      {screen === 'task12' && <Task12DeviceScreen />}
      {screen === 'task7' && <Task7PromptScreen />}
      {screen === 'task6' && <Task6DeviceScreen />}
      {screen === 'q1' && <Q1GrammarSpikeScreen />}
      {screen === 'dateStr' && <DateStrProbeScreen />}
      {screen === 'ruleName' && <RuleNameProbeScreen />}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  switcher: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    paddingTop: 8,
    paddingBottom: 4,
  },
});

export default App;
