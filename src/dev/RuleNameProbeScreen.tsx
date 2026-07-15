/**
 * Rule-name disambiguation probes — Q1c
 * docs/briefs/Q1c_rule_name_disambiguation_brief.md
 *
 * THROWAWAY DEV SPIKE, NOT PRODUCTION CODE, NOT YET A CONFIRMED FIX. Reopens Q1b's conclusion
 * ("a jchar{m,n}-based rule must be named to match its own JSON key exactly" -
 * docs/eval/Q1b_findings_report.md). That conclusion rested on the M-vs-N probe pair
 * (src/dev/DateStrProbeScreen.tsx), which changed TWO things at once when renaming
 * `foo_str` -> `foo`: the name became identical to its key, AND it lost its underscore. Only
 * one of those was ever isolated.
 *
 * The competing theory: llama.cpp's GBNF parser lexes rule names with an `is_word_char`
 * predicate that accepts letters, digits, and `-` - NOT `_`. An underscore in a rule name
 * terminates the identifier early and the parser chokes on the stray `_`. This has a real
 * mechanism (GBNF rule names are arbitrary identifiers with no concept of "their" JSON key);
 * key-matching has none. The underscore theory also explains every single Q1b data point:
 * every failing probe had an underscored rule name in play; every passing probe didn't.
 *
 * §1 of the brief is four probes (Q1-Q4) that hold everything else constant (body, indirection
 * depth, self-owned quotes, {1,80} bound - all proven-safe) and vary ONLY the rule name, so the
 * two theories predict opposite results for Q1/Q2. §1 landed on the underscore theory
 * (docs/eval/Q1c_findings_report.md) - the global rename this unblocked (§2, every checked-in
 * .gbnf) has already been applied and is NOT re-tested by this screen's probes.
 *
 * §3 (Probe R) and §4 (Probes S1-S3, T) below are LIVE, NOT-YET-RUN probes for the renamed
 * grammar: §3 asks whether `boundedIntRule`'s original `[1-9] [0-9]{0,3}` shape parses under a
 * clean name (if so, no structural change is needed - see primitives.ts, still the plain
 * form); §4 fires the three previously-untested coaching fields and the full `due` union under
 * their real post-rename names, on-device, so a rename never gets shipped without actually
 * being parsed once.
 *
 * Split into its own screen (not more buttons on Q1GrammarSpikeScreen or DateStrProbeScreen)
 * per the same precedent DateStrProbeScreen itself set: a distinct investigative thread,
 * kept navigable via adb tap coordinates on a real device.
 *
 * Model load path is duplicated from DateStrProbeScreen.tsx (same convention that file itself
 * used when cribbing from Q1GrammarSpikeScreen.tsx) - a small, intentional duplication for a
 * throwaway spike, not a shared module.
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
  console.log('[RuleNameProbe]', line);
}

/** Tagged, chunked JSON logging — same convention as DateStrProbeScreen.tsx's logResultJson,
 *  so scripts/q1-reassemble.js can pull these results too. Distinct tag prefix (Q1CRESULT)
 *  per the brief, so this session's results don't collide with Q1b's in a shared logcat dump. */
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

const JCHAR_LINE =
  'jchar ::= [^"\\\\\\x00-\\x1F] | "\\\\" (["\\\\/bfnrt] | "u" [0-9a-fA-F]{4})';

export default function RuleNameProbeScreen() {
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

  // Probe Q1 — underscore, MATCHES its key (`foo_bar`/`foo_bar`). Key-matching predicts PASS
  // (name matches key); underscore theory predicts FAIL (name contains `_`). Opposite
  // predictions - this is half of the decisive pair.
  const runProbeQ1 = useCallback(async () => {
    setRunning(true);
    try {
      const grammar =
        'root ::= "{\\"foo_bar\\":" foo_bar "}"\n' +
        'foo_bar ::= "\\"" jchar{1,80} "\\""\n' +
        JCHAR_LINE;
      appendLog('Probe Q1: key="foo_bar", rule="foo_bar" (underscore, matches key) ...');
      try {
        const result = await runCompletion(
          [{ role: 'user', content: 'Reply with exactly {"foo_bar":"hello there"}' }],
          { grammar, n_predict: 30 },
        );
        const text = (result.text ?? '').trim();
        appendLog(`Probe Q1: PASS output=${JSON.stringify(text)}`);
        logResultJson('Q1CRESULT:probeQ1', {
          pass: true,
          grammar,
          rawOutput: text,
          timings: extractTimings(result),
        });
      } catch (err: any) {
        appendLog(`Probe Q1: FAIL ${String(err)}`);
        logResultJson('Q1CRESULT:probeQ1', { pass: false, grammar, error: String(err) });
      }
    } finally {
      setRunning(false);
    }
  }, [appendLog, runCompletion]);

  // Probe Q2 — no underscore, does NOT match its key (`foo`/`xyzzy`). Key-matching predicts
  // FAIL (name doesn't match key); underscore theory predicts PASS (no `_` anywhere). Opposite
  // predictions - the other half of the decisive pair. Q1+Q2 together are the whole experiment.
  const runProbeQ2 = useCallback(async () => {
    setRunning(true);
    try {
      const grammar =
        'root ::= "{\\"foo\\":" xyzzy "}"\n' + 'xyzzy ::= "\\"" jchar{1,80} "\\""\n' + JCHAR_LINE;
      appendLog('Probe Q2: key="foo", rule="xyzzy" (no underscore, no match) ...');
      try {
        const result = await runCompletion(
          [{ role: 'user', content: 'Reply with exactly {"foo":"hello there"}' }],
          { grammar, n_predict: 30 },
        );
        const text = (result.text ?? '').trim();
        appendLog(`Probe Q2: PASS output=${JSON.stringify(text)}`);
        logResultJson('Q1CRESULT:probeQ2', {
          pass: true,
          grammar,
          rawOutput: text,
          timings: extractTimings(result),
        });
      } catch (err: any) {
        appendLog(`Probe Q2: FAIL ${String(err)}`);
        logResultJson('Q1CRESULT:probeQ2', { pass: false, grammar, error: String(err) });
      }
    } finally {
      setRunning(false);
    }
  }, [appendLog, runCompletion]);

  // Probe Q3 — dash, not underscore (`foo`/`foo-bar`). is_word_char DOES accept `-` per the
  // brief's mechanism, so underscore theory predicts PASS here too. Tests whether `-` is a
  // safe naming convention for the eventual de-underscored rule names.
  const runProbeQ3 = useCallback(async () => {
    setRunning(true);
    try {
      const grammar =
        'root ::= "{\\"foo\\":" foo-bar "}"\n' +
        'foo-bar ::= "\\"" jchar{1,80} "\\""\n' +
        JCHAR_LINE;
      appendLog('Probe Q3: key="foo", rule="foo-bar" (dash, no match) ...');
      try {
        const result = await runCompletion(
          [{ role: 'user', content: 'Reply with exactly {"foo":"hello there"}' }],
          { grammar, n_predict: 30 },
        );
        const text = (result.text ?? '').trim();
        appendLog(`Probe Q3: PASS output=${JSON.stringify(text)}`);
        logResultJson('Q1CRESULT:probeQ3', {
          pass: true,
          grammar,
          rawOutput: text,
          timings: extractTimings(result),
        });
      } catch (err: any) {
        appendLog(`Probe Q3: FAIL ${String(err)}`);
        logResultJson('Q1CRESULT:probeQ3', { pass: false, grammar, error: String(err) });
      }
    } finally {
      setRunning(false);
    }
  }, [appendLog, runCompletion]);

  // Probe Q4 — known-fail control, byte-for-byte Q1b's Probe M (`foo`/`foo_str`). Underscore
  // AND no key match - both theories predict FAIL. Proves this harness reproduces the known
  // bug before trusting Q1/Q2/Q3's results against it.
  const runProbeQ4 = useCallback(async () => {
    setRunning(true);
    try {
      const grammar =
        'root ::= "{\\"foo\\":" foo_str "}"\n' +
        'foo_str ::= "\\"" jchar{1,80} "\\""\n' +
        JCHAR_LINE;
      appendLog('Probe Q4: key="foo", rule="foo_str" (underscore, no match - known-fail control) ...');
      try {
        const result = await runCompletion(
          [{ role: 'user', content: 'Reply with exactly {"foo":"hello there"}' }],
          { grammar, n_predict: 30 },
        );
        const text = (result.text ?? '').trim();
        appendLog(`Probe Q4: PASS output=${JSON.stringify(text)}`);
        logResultJson('Q1CRESULT:probeQ4', {
          pass: true,
          grammar,
          rawOutput: text,
          timings: extractTimings(result),
        });
      } catch (err: any) {
        appendLog(`Probe Q4: FAIL ${String(err)}`);
        logResultJson('Q1CRESULT:probeQ4', { pass: false, grammar, error: String(err) });
      }
    } finally {
      setRunning(false);
    }
  }, [appendLog, runCompletion]);

  // Probe R — §3: re-test the ORIGINAL bounded-integer shape (`[1-9] [0-9]{0,3}`, no
  // digit-width alternation) under a clean, underscore-free name. This is the exact shape
  // `boundedIntRule`/`estimatedDurationMinutes` already use in the real .gbnf files (the
  // digit-width alternation from Q1b Probe A was validated but never applied to
  // primitives.ts). If Q1/Q2 confirmed the underscore theory, this should PASS - Q1's
  // original "bounded-integer shape is broken" verdict was itself naming collateral, and
  // `boundedIntRule` needs no structural change. If this FAILS, the alternation needs to be
  // implemented after all.
  const runProbeR = useCallback(async () => {
    setRunning(true);
    try {
      const grammar =
        'root ::= "{\\"minutes\\":" durationMinutes "}"\n' +
        'durationMinutes ::= [1-9] [0-9]{0,3}';
      appendLog('Probe R (§3): plain [1-9] [0-9]{0,3} under a clean name (durationMinutes) ...');
      try {
        const result = await runCompletion(
          [{ role: 'user', content: 'Reply with exactly {"minutes":245}' }],
          { grammar, n_predict: 20 },
        );
        const text = (result.text ?? '').trim();
        appendLog(`Probe R: PASS output=${JSON.stringify(text)}`);
        logResultJson('Q1CRESULT:probeR', {
          pass: true,
          grammar,
          rawOutput: text,
          timings: extractTimings(result),
        });
      } catch (err: any) {
        appendLog(`Probe R: FAIL ${String(err)}`);
        logResultJson('Q1CRESULT:probeR', { pass: false, grammar, error: String(err) });
      }
    } finally {
      setRunning(false);
    }
  }, [appendLog, runCompletion]);

  // Probe S1 — §4: fire `changesNotes` (was `changes_notes`) for real, in its actual
  // `modify_task`/`changes` context, renamed per §2. One of the three coaching fields Q1b
  // flagged but never tested; `coaching_resolution` is what task 12 fires at users mid-skip-
  // conversation, so a rename that was never actually parsed is exactly the silent-crash risk
  // the brief calls out.
  const runProbeS1 = useCallback(async () => {
    setRunning(true);
    try {
      const grammar =
        'root ::= "{\\"action\\":\\"modify_task\\",\\"task_id\\":\\"1\\",\\"changes\\":" changes "}"\n' +
        'changes ::= "{\\"duration_minutes\\":null,\\"context_tags\\":null,\\"energy\\":null,\\"approach_notes\\":" changesNotes "}"\n' +
        'changesNotes ::= "null" | "\\"" jchar{1,200} "\\""\n' +
        JCHAR_LINE;
      appendLog('Probe S1 (§4): changesNotes (was changes_notes) in real modify_task/changes shape ...');
      try {
        const result = await runCompletion(
          [
            {
              role: 'user',
              content: 'Reply with exactly {"action":"modify_task","task_id":"1","changes":{"duration_minutes":null,"context_tags":null,"energy":null,"approach_notes":"try mornings instead"}}',
            },
          ],
          { grammar, n_predict: 80 },
        );
        const text = (result.text ?? '').trim();
        appendLog(`Probe S1: PASS output=${JSON.stringify(text)}`);
        logResultJson('Q1CRESULT:probeS1', {
          pass: true,
          grammar,
          rawOutput: text,
          timings: extractTimings(result),
        });
      } catch (err: any) {
        appendLog(`Probe S1: FAIL ${String(err)}`);
        logResultJson('Q1CRESULT:probeS1', { pass: false, grammar, error: String(err) });
      }
    } finally {
      setRunning(false);
    }
  }, [appendLog, runCompletion]);

  // Probe S2 — §4: fire `reason120` (already underscore-free - digits only, no rename needed)
  // in its real `eliminate_task` context, to confirm it parses now that its sibling rules in
  // the same file are de-underscored (a union grammar fails to compile as a whole if ANY
  // branch has a bad rule name, even one this specific branch doesn't visit).
  const runProbeS2 = useCallback(async () => {
    setRunning(true);
    try {
      const grammar =
        'root ::= "{\\"action\\":\\"eliminate_task\\",\\"task_id\\":\\"1\\",\\"reason\\":" reason120 "}"\n' +
        'reason120 ::= "\\"" jchar{1,120} "\\""\n' +
        JCHAR_LINE;
      appendLog('Probe S2 (§4): reason120 in real eliminate_task shape ...');
      try {
        const result = await runCompletion(
          [
            {
              role: 'user',
              content: 'Reply with exactly {"action":"eliminate_task","task_id":"1","reason":"no longer relevant"}',
            },
          ],
          { grammar, n_predict: 60 },
        );
        const text = (result.text ?? '').trim();
        appendLog(`Probe S2: PASS output=${JSON.stringify(text)}`);
        logResultJson('Q1CRESULT:probeS2', {
          pass: true,
          grammar,
          rawOutput: text,
          timings: extractTimings(result),
        });
      } catch (err: any) {
        appendLog(`Probe S2: FAIL ${String(err)}`);
        logResultJson('Q1CRESULT:probeS2', { pass: false, grammar, error: String(err) });
      }
    } finally {
      setRunning(false);
    }
  }, [appendLog, runCompletion]);

  // Probe S3 — §4: fire `condition120` in its real `until_condition` -> `untilCondition`
  // context (renamed per §2), nested inside `defer_task`'s `until` union - the deepest of the
  // three coaching fields structurally.
  const runProbeS3 = useCallback(async () => {
    setRunning(true);
    try {
      const grammar =
        'root ::= "{\\"action\\":\\"defer_task\\",\\"task_id\\":\\"1\\",\\"until\\":" until "}"\n' +
        'until ::= untilCondition\n' +
        'untilCondition ::= "{\\"condition\\":" condition120 "}"\n' +
        'condition120 ::= "\\"" jchar{1,120} "\\""\n' +
        JCHAR_LINE;
      appendLog('Probe S3 (§4): condition120 in real until_condition/untilCondition shape ...');
      try {
        const result = await runCompletion(
          [
            {
              role: 'user',
              content:
                'Reply with exactly {"action":"defer_task","task_id":"1","until":{"condition":"after the kitchen renovation is done"}}',
            },
          ],
          { grammar, n_predict: 80 },
        );
        const text = (result.text ?? '').trim();
        appendLog(`Probe S3: PASS output=${JSON.stringify(text)}`);
        logResultJson('Q1CRESULT:probeS3', {
          pass: true,
          grammar,
          rawOutput: text,
          timings: extractTimings(result),
        });
      } catch (err: any) {
        appendLog(`Probe S3: FAIL ${String(err)}`);
        logResultJson('Q1CRESULT:probeS3', { pass: false, grammar, error: String(err) });
      }
    } finally {
      setRunning(false);
    }
  }, [appendLog, runCompletion]);

  // Probe T — §4: the full `due` union, byte-for-byte the real (post-rename)
  // task_extraction.v1.gbnf shape - dueOnDate/dueInDays/dueWeekday, daysInt as the plain
  // `[1-9] [0-9]{0,2}` form (no alternation), date self-quoting per Q1b's fix. This is
  // DateStrProbeScreen's Probe F re-run with the real renamed rule set, to confirm the whole
  // union (not just isolated fields) still parses end-to-end.
  const runProbeT = useCallback(async () => {
    setRunning(true);
    try {
      const grammar = [
        'root ::= "{\\"title\\":" title ",\\"due\\":" due "}"',
        'title ::= "\\"" jchar{1,80} "\\""',
        'due ::= "null" | dueOnDate | dueInDays | dueWeekday',
        'dueOnDate ::= "{\\"kind\\":\\"on_date\\",\\"date\\":" date "}"',
        'date ::= "\\"" jchar{1,10} "\\""',
        'dueInDays ::= "{\\"kind\\":\\"in_days\\",\\"days\\":" daysInt "}"',
        'daysInt ::= [1-9] [0-9]{0,2}',
        'dueWeekday ::= "{\\"kind\\":\\"weekday\\",\\"day\\":" weekday ",\\"which\\":" which "}"',
        'which ::= "\\"this\\"" | "\\"next\\""',
        'weekday ::= "\\"monday\\"" | "\\"tuesday\\"" | "\\"wednesday\\"" | "\\"thursday\\"" | "\\"friday\\"" | "\\"saturday\\"" | "\\"sunday\\""',
        JCHAR_LINE,
      ].join('\n');
      appendLog('Probe T (§4): full due union, real post-rename shape ...');
      try {
        const result = await runCompletion(
          [{ role: 'user', content: 'I have to call the insurance company on 2026-08-01' }],
          { grammar, n_predict: 60 },
        );
        const text = (result.text ?? '').trim();
        appendLog(`Probe T: PASS output=${JSON.stringify(text)}`);
        logResultJson('Q1CRESULT:probeT', {
          pass: true,
          grammar,
          rawOutput: text,
          timings: extractTimings(result),
        });
      } catch (err: any) {
        appendLog(`Probe T: FAIL ${String(err)}`);
        logResultJson('Q1CRESULT:probeT', { pass: false, grammar, error: String(err) });
      }
    } finally {
      setRunning(false);
    }
  }, [appendLog, runCompletion]);

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ paddingBottom: 32 }}>
      <Text style={styles.title}>Rule-name disambiguation probes (Q1c §1)</Text>
      <Button
        title="Probe Q1: foo_bar/foo_bar (underscore, matches key)"
        onPress={runProbeQ1}
        disabled={running}
      />
      <View style={{ height: 8 }} />
      <Button
        title="Probe Q2: foo/xyzzy (no underscore, no match)"
        onPress={runProbeQ2}
        disabled={running}
      />
      <View style={{ height: 8 }} />
      <Button title="Probe Q3: foo/foo-bar (dash)" onPress={runProbeQ3} disabled={running} />
      <View style={{ height: 8 }} />
      <Button
        title="Probe Q4: foo/foo_str (known-fail control)"
        onPress={runProbeQ4}
        disabled={running}
      />
      <View style={{ height: 16 }} />
      <Text style={styles.title}>§3 — boundedIntRule retest</Text>
      <Button
        title="Probe R: [1-9][0-9]{0,3} under clean name (durationMinutes)"
        onPress={runProbeR}
        disabled={running}
      />
      <View style={{ height: 16 }} />
      <Text style={styles.title}>§4 — fire the renamed grammars for real</Text>
      <Button
        title="Probe S1: changesNotes in real modify_task shape"
        onPress={runProbeS1}
        disabled={running}
      />
      <View style={{ height: 8 }} />
      <Button
        title="Probe S2: reason120 in real eliminate_task shape"
        onPress={runProbeS2}
        disabled={running}
      />
      <View style={{ height: 8 }} />
      <Button
        title="Probe S3: condition120 in real until_condition shape"
        onPress={runProbeS3}
        disabled={running}
      />
      <View style={{ height: 8 }} />
      <Button
        title="Probe T: full due union, real post-rename shape"
        onPress={runProbeT}
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
