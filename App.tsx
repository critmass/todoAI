/**
 * The app entry point.
 *
 * As of task 24 this renders the PRODUCT UI (`src/app/`). The `src/dev/` harnesses that used to
 * live here are still reachable — task 13's in particular is the only way to drive the timer
 * engine directly, and future device passes will want it — but they are dev tools now, not the
 * app, and they are only reachable in a debug build.
 */

import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';

import ProductApp from './src/app/App';
import DateStrProbeScreen from './src/dev/DateStrProbeScreen';
import ModelBaseSpikeScreen from './src/dev/ModelBaseSpikeScreen';
import Q1GrammarSpikeScreen from './src/dev/Q1GrammarSpikeScreen';
import RuleNameProbeScreen from './src/dev/RuleNameProbeScreen';
import Task6DeviceScreen from './src/dev/Task6DeviceScreen';
import Task7PromptScreen from './src/dev/Task7PromptScreen';
import Task12DeviceScreen from './src/dev/Task12DeviceScreen';
import Task13DeviceScreen from './src/dev/Task13DeviceScreen';

type DevScreen =
  | 'task13'
  | 'task12'
  | 'task7'
  | 'task6'
  | 'q1'
  | 'dateStr'
  | 'ruleName'
  | 'modelBase';

function App() {
  const [dev, setDev] = useState<DevScreen | null>(null);

  if (dev) {
    return (
      <SafeAreaProvider>
        <DevHarness screen={dev} onExit={() => setDev(null)} />
      </SafeAreaProvider>
    );
  }

  return (
    <>
      <ProductApp />
      {__DEV__ ? <DevAffordance onOpen={() => setDev('task13')} /> : null}
    </>
  );
}

/** A deliberately tiny, corner-parked way into the harnesses. Debug builds only, and small enough
 *  that it cannot be mistaken for part of the product or fat-fingered mid-session. */
function DevAffordance({ onOpen }: { onOpen: () => void }) {
  return (
    <Pressable onPress={onOpen} style={styles.devDot} accessibilityLabel="Developer harnesses">
      <Text style={styles.devDotLabel}>dev</Text>
    </Pressable>
  );
}

function DevHarness({ screen, onExit }: { screen: DevScreen; onExit: () => void }) {
  const [current, setCurrent] = useState<DevScreen>(screen);
  const insets = useSafeAreaInsets();
  const tabs: Array<[DevScreen, string]> = [
    ['task13', 'T13'],
    ['task12', 'T12'],
    ['task7', 'T7'],
    ['task6', 'T6'],
    ['q1', 'Q1'],
    ['dateStr', 'date'],
    ['ruleName', 'rule'],
    ['modelBase', 'base'],
  ];
  return (
    <View style={styles.harness}>
      <View style={[styles.switcher, { paddingTop: insets.top + 8 }]}>
        <Pressable onPress={onExit} hitSlop={8}>
          <Text style={styles.exit}>← app</Text>
        </Pressable>
        {tabs.map(([key, label]) => (
          <Pressable key={key} onPress={() => setCurrent(key)} hitSlop={8}>
            <Text style={current === key ? styles.tabActive : styles.tab}>{label}</Text>
          </Pressable>
        ))}
      </View>
      {current === 'task13' && <Task13DeviceScreen />}
      {current === 'task12' && <Task12DeviceScreen />}
      {current === 'task7' && <Task7PromptScreen />}
      {current === 'task6' && <Task6DeviceScreen />}
      {current === 'q1' && <Q1GrammarSpikeScreen />}
      {current === 'dateStr' && <DateStrProbeScreen />}
      {current === 'ruleName' && <RuleNameProbeScreen />}
      {current === 'modelBase' && <ModelBaseSpikeScreen />}
    </View>
  );
}

const styles = StyleSheet.create({
  harness: { flex: 1 },
  switcher: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    alignItems: 'center',
    paddingBottom: 6,
  },
  exit: { fontSize: 13, fontWeight: '700', color: '#3A5A40' },
  tab: { fontSize: 13, color: '#6B6B70' },
  tabActive: { fontSize: 13, fontWeight: '700', color: '#1B1B1F' },
  devDot: {
    position: 'absolute',
    right: 6,
    bottom: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 10,
    backgroundColor: 'rgba(27,27,31,0.35)',
  },
  devDotLabel: { fontSize: 10, color: '#FFFFFF' },
});

export default App;
