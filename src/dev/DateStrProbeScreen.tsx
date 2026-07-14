/**
 * date_str isolation probes — follow-on to Q1b
 * docs/briefs/Q1b_bounded_integer_probe_brief.md
 *
 * THROWAWAY DEV SPIKE, NOT PRODUCTION CODE, NOT BRIEF-MANDATED. Opened live on-device after
 * Q1b's Probe C (the `due` sub-grammar with the boundedIntRule digit-width fix applied to
 * days_int) still failed to parse despite NOT crashing the process. Isolating date_str alone
 * (`[0-9] [0-9] [0-9] [0-9] "-" [0-9] [0-9] "-" [0-9] [0-9]`) confirmed a second, independent
 * grammar bug: it fails to parse even though it has NO optionality at all — contradicting the
 * Q1 findings report's own characterized trigger ("mandatory class immediately followed by
 * optional"). Crossed with Q1b Probe A (whose grammar contains `i4 ::= [1-9] [0-9] [0-9]
 * [0-9]` — 4 consecutive mandatory classes, no literals — and parsed fine), raw class-adjacency
 * count isn't it either. What's different about date_str is multiple class-group <-> literal
 * transitions within one rule. These probes narrow down which variable actually matters:
 * separator count, or literal identity.
 *
 * Split into its own screen rather than growing Q1GrammarSpikeScreen.tsx further — that
 * harness was already ~20 buttons deep and hard to navigate via adb tap coordinates on a real
 * device, and this is a separate, narrower investigative thread, not part of the Q1b brief's
 * own scope (which was `boundedIntRule` only).
 *
 * Model load path is duplicated from Q1GrammarSpikeScreen.tsx (same convention that file
 * itself used when cribbing from the now-deleted BonsaiSpikeScreen.tsx) — a small,
 * intentional duplication for a throwaway spike, not a shared module.
 */

import React, { useCallback, useRef, useState } from 'react';
import { Button, ScrollView, StyleSheet, Text, View } from 'react-native';
import { initLlama, type LlamaContext, type RNLlamaOAICompatibleMessage } from 'llama.rn';

const MODEL_FILENAME = 'Ternary-Bonsai-4B-TQ1_0.gguf';
const MODEL_PATH = `file:///sdcard/Android/data/com.todoai/files/${MODEL_FILENAME}`;
const N_CTX = 2048;
const N_THREADS = 4;
const N_GPU_LAYERS = 0;

function appendAndLog(setLog: React.Dispatch<React.SetStateAction<string[]>>, line: string): void {
  setLog((prev) => [...prev, line]);
  console.log('[DateStrProbe]', line);
}

/** Tagged, chunked JSON logging — same convention as Q1GrammarSpikeScreen.tsx's
 *  logResultJson, so scripts/q1-reassemble.js can pull these results too. */
function logResultJson(tag: string, value: unknown): void {
  const json = JSON.stringify(value);
  const CHUNK_SIZE = 3000;
  const totalChunks = Math.max(1, Math.ceil(json.length / CHUNK_SIZE));
  for (let i = 0; i < totalChunks; i++) {
    const chunk = json.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
    console.log(`[${tag} ${i + 1}/${totalChunks}] ${chunk}`);
  }
}

function extractTimings(result: { timings?: Record<string, number> }) {
  const t = result.timings ?? {};
  return {
    promptMs: t.prompt_ms ?? 0,
    promptPerSecond: t.prompt_per_second ?? 0,
    predictedN: t.predicted_n ?? 0,
    predictedPerSecond: t.predicted_per_second ?? 0,
  };
}

export default function DateStrProbeScreen() {
  const [log, setLog] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const contextRef = useRef<LlamaContext | null>(null);

  const appendLog = useCallback((line: string) => appendAndLog(setLog, line), []);

  const ensureModelLoaded = useCallback(async (): Promise<LlamaContext> => {
    if (contextRef.current) return contextRef.current;
    const start = Date.now();
    appendLog(
      `Loading ${MODEL_PATH} (ctx=${N_CTX}, threads=${N_THREADS}, gpu_layers=${N_GPU_LAYERS}) ...`,
    );
    try {
      const ctx = await initLlama({
        model: MODEL_PATH,
        use_mlock: true,
        n_ctx: N_CTX,
        n_threads: N_THREADS,
        n_gpu_layers: N_GPU_LAYERS,
      });
      contextRef.current = ctx;
      appendLog(`Model loaded in ${Date.now() - start}ms`);
      return ctx;
    } catch (err: any) {
      appendLog(`LOAD FAILED: ${String(err)}`);
      throw err;
    }
  }, [appendLog]);

  const runCompletion = useCallback(
    async (
      messages: RNLlamaOAICompatibleMessage[],
      opts: { grammar: string; n_predict: number },
    ) => {
      const ctx = await ensureModelLoaded();
      return ctx.completion({
        messages,
        grammar: opts.grammar,
        n_predict: opts.n_predict,
        temperature: 0,
        top_k: 1,
      });
    },
    [ensureModelLoaded],
  );

  // Probe C1 (moved here from Q1GrammarSpikeScreen.tsx) — date_str's full shape: 4-2-2 digit
  // groups, two "-" separators. Confirmed FAIL on-device (2026-07-13): "Error: failed to
  // parse grammar".
  const runProbeC1 = useCallback(async () => {
    setRunning(true);
    try {
      const grammar =
        'root ::= "{\\"date\\":\\"" date_str "\\"}"\n' +
        'date_str ::= [0-9] [0-9] [0-9] [0-9] "-" [0-9] [0-9] "-" [0-9] [0-9]';
      appendLog('Probe C1: date_str full shape (4-2-2, two separators) ...');
      try {
        const result = await runCompletion(
          [{ role: 'user', content: 'Reply with exactly {"date":"2026-07-13"}' }],
          { grammar, n_predict: 30 },
        );
        const text = (result.text ?? '').trim();
        appendLog(`Probe C1: PASS output=${JSON.stringify(text)}`);
        logResultJson('Q1RESULT:probeC1', {
          pass: true,
          grammar,
          rawOutput: text,
          timings: extractTimings(result),
        });
      } catch (err: any) {
        appendLog(`Probe C1: FAIL ${String(err)}`);
        logResultJson('Q1RESULT:probeC1', { pass: false, grammar, error: String(err) });
      }
    } finally {
      setRunning(false);
    }
  }, [appendLog, runCompletion]);

  // Probe D1 — ONE separator, 2-2 digit groups (the last two segments of date_str, minus the
  // 4-digit year). Tests whether a single class-literal-class transition alone is enough to
  // break parsing, or whether date_str's failure needs two separator occurrences.
  const runProbeD1 = useCallback(async () => {
    setRunning(true);
    try {
      const grammar = 'root ::= "{\\"md\\":\\"" md_str "\\"}"\nmd_str ::= [0-9] [0-9] "-" [0-9] [0-9]';
      appendLog('Probe D1: one separator, 2-2 groups ...');
      try {
        const result = await runCompletion(
          [{ role: 'user', content: 'Reply with exactly {"md":"07-13"}' }],
          { grammar, n_predict: 30 },
        );
        const text = (result.text ?? '').trim();
        appendLog(`Probe D1: PASS output=${JSON.stringify(text)}`);
        logResultJson('Q1RESULT:probeD1', {
          pass: true,
          grammar,
          rawOutput: text,
          timings: extractTimings(result),
        });
      } catch (err: any) {
        appendLog(`Probe D1: FAIL ${String(err)}`);
        logResultJson('Q1RESULT:probeD1', { pass: false, grammar, error: String(err) });
      }
    } finally {
      setRunning(false);
    }
  }, [appendLog, runCompletion]);

  // Probe D2 — TWO separators, minimal 1-1-1 digit groups. Tests whether it's the COUNT of
  // class-literal transitions in one rule (independent of how many classes are in each group)
  // that triggers the failure, by reproducing date_str's two-separator shape at the smallest
  // possible size.
  const runProbeD2 = useCallback(async () => {
    setRunning(true);
    try {
      const grammar = 'root ::= "{\\"x\\":\\"" x_str "\\"}"\nx_str ::= [0-9] "-" [0-9] "-" [0-9]';
      appendLog('Probe D2: two separators, 1-1-1 groups ...');
      try {
        const result = await runCompletion(
          [{ role: 'user', content: 'Reply with exactly {"x":"1-2-3"}' }],
          { grammar, n_predict: 30 },
        );
        const text = (result.text ?? '').trim();
        appendLog(`Probe D2: PASS output=${JSON.stringify(text)}`);
        logResultJson('Q1RESULT:probeD2', {
          pass: true,
          grammar,
          rawOutput: text,
          timings: extractTimings(result),
        });
      } catch (err: any) {
        appendLog(`Probe D2: FAIL ${String(err)}`);
        logResultJson('Q1RESULT:probeD2', { pass: false, grammar, error: String(err) });
      }
    } finally {
      setRunning(false);
    }
  }, [appendLog, runCompletion]);

  // Probe D3 — same shape as D1 (one separator, 2-2 groups) but a different literal (":"
  // instead of "-"). Tests whether the failure is specific to the "-" character or general to
  // any literal separator wedged between character-class groups.
  const runProbeD3 = useCallback(async () => {
    setRunning(true);
    try {
      const grammar = 'root ::= "{\\"t\\":\\"" t_str "\\"}"\nt_str ::= [0-9] [0-9] ":" [0-9] [0-9]';
      appendLog('Probe D3: one separator, different literal (":") ...');
      try {
        const result = await runCompletion(
          [{ role: 'user', content: 'Reply with exactly {"t":"07:13"}' }],
          { grammar, n_predict: 30 },
        );
        const text = (result.text ?? '').trim();
        appendLog(`Probe D3: PASS output=${JSON.stringify(text)}`);
        logResultJson('Q1RESULT:probeD3', {
          pass: true,
          grammar,
          rawOutput: text,
          timings: extractTimings(result),
        });
      } catch (err: any) {
        appendLog(`Probe D3: FAIL ${String(err)}`);
        logResultJson('Q1RESULT:probeD3', { pass: false, grammar, error: String(err) });
      }
    } finally {
      setRunning(false);
    }
  }, [appendLog, runCompletion]);

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ paddingBottom: 32 }}>
      <Text style={styles.title}>date_str isolation probes (Q1b follow-on)</Text>
      <Button
        title="Probe C1: date_str full shape (4-2-2, 2 seps)"
        onPress={runProbeC1}
        disabled={running}
      />
      <View style={{ height: 8 }} />
      <Button title="Probe D1: one separator, 2-2 groups" onPress={runProbeD1} disabled={running} />
      <View style={{ height: 8 }} />
      <Button
        title="Probe D2: two separators, 1-1-1 groups"
        onPress={runProbeD2}
        disabled={running}
      />
      <View style={{ height: 8 }} />
      <Button
        title="Probe D3: one separator, different literal"
        onPress={runProbeD3}
        disabled={running}
      />
      <View style={{ height: 16 }} />
      {log.map((line, i) => (
        <Text key={i} style={styles.logLine}>
          {line}
        </Text>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16 },
  title: { fontSize: 16, fontWeight: '600', marginBottom: 12 },
  logLine: { fontFamily: 'monospace', fontSize: 12, marginBottom: 2 },
});
