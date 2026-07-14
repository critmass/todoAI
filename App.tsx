/**
 * Sample React Native App
 * https://github.com/facebook/react-native
 *
 * @format
 */

import { useState } from 'react';
import { Button, StatusBar, StyleSheet, useColorScheme, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
// TEMPORARY swap for the Q1 grammar smoke test (docs/briefs/Q1_grammar_smoke_test_brief.md) —
// revert to NewAppScreen once Q1 is done. See src/dev/Q1GrammarSpikeScreen.tsx.
import Q1GrammarSpikeScreen from './src/dev/Q1GrammarSpikeScreen';
// Q1b follow-on: date_str isolation probes (docs/briefs/Q1b_bounded_integer_probe_brief.md),
// split into its own screen to keep Q1GrammarSpikeScreen navigable. See
// src/dev/DateStrProbeScreen.tsx.
import DateStrProbeScreen from './src/dev/DateStrProbeScreen';

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
  const [screen, setScreen] = useState<'q1' | 'dateStr'>('q1');

  return (
    <View style={styles.container}>
      <View style={styles.switcher}>
        <Button title="Q1 Harness" onPress={() => setScreen('q1')} disabled={screen === 'q1'} />
        <Button
          title="date_str Probes"
          onPress={() => setScreen('dateStr')}
          disabled={screen === 'dateStr'}
        />
      </View>
      {screen === 'q1' ? <Q1GrammarSpikeScreen /> : <DateStrProbeScreen />}
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
