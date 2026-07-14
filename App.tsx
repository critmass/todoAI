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
  const [screen, setScreen] = useState<'q1' | 'dateStr' | 'ruleName'>('q1');
  // Bug fixed live (2026-07-13): this switcher was rendering under the status bar with no
  // top inset - the "date_str Probes" button was visible on-screen but its taps were being
  // intercepted by the status bar area instead of reaching the Button, so switching never
  // fired. useSafeAreaInsets pushes it below the status bar/notch.
  const insets = useSafeAreaInsets();

  return (
    <View style={styles.container}>
      <View style={[styles.switcher, { paddingTop: insets.top + 8 }]}>
        <Button title="Q1 Harness" onPress={() => setScreen('q1')} disabled={screen === 'q1'} />
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
