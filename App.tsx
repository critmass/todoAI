/**
 * Sample React Native App
 * https://github.com/facebook/react-native
 *
 * @format
 */

import { StatusBar, StyleSheet, useColorScheme, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
// TEMPORARY swap for the Q1 grammar smoke test (docs/briefs/Q1_grammar_smoke_test_brief.md) —
// revert to NewAppScreen once Q1 is done. See src/dev/Q1GrammarSpikeScreen.tsx.
import Q1GrammarSpikeScreen from './src/dev/Q1GrammarSpikeScreen';

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
  return (
    <View style={styles.container}>
      <Q1GrammarSpikeScreen />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
});

export default App;
