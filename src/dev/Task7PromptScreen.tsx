/**
 * Task 7 — Phase B prompt-tuning harness (S23 FE).
 * docs/briefs/opus_batch_B_device.md §"Task 7". THROWAWAY DEV SPIKE, NOT PRODUCTION.
 *
 * The draft→run→observe→adjust loop. Unlike Task6DeviceScreen (which proved the provider works
 * using Q1's deliberately-minimal prompt for like-for-like numbers), this drives the REAL task-7
 * prompts — `assembleExtractionPrompt` / `EXTRACTION_FIELD_GUIDE` — so what's measured is the
 * prompt we actually ship.
 *
 * KPI: valid-AND-correct. Validity is already solved (Q1c 4/4, re-confirmed in task 6); this
 * tracks CORRECT — right fields, right recurrence type, right due date — scored against each
 * fixture's `gold` block by ./extractionScoring.ts (unit-tested; the loop keys off it).
 *
 * Buttons:
 *   Quick (4)   — the Q1 subset. Fast (~2.5 min) iteration signal while editing the prompt.
 *   Full (16)   — the real KPI across every seed fixture (~10 min). Run before/after a prompt edit.
 *   Ask (probe) — the D6 ask-don't-guess check: feeds the AMBIGUOUS fixtures WITHOUT their
 *                 clarify_answers as an unconstrained prose turn, and asks whether the model
 *                 QUESTIONS the ambiguity instead of silently picking null-vs-unscheduled. This
 *                 cannot be tested through the constrained call — the grammar forces a full object,
 *                 so a question is structurally impossible there. That is exactly why D1's prose
 *                 turn exists.
 *
 * Tuning loop: edit src/llm/prompts/fieldGuides.ts → Metro reload → re-run → compare KPI.
 * Results log as chunked [T7RESULT:*] lines; capture with `adb logcat -s ReactNativeJS:*`.
 * Device discipline: run a couple of minutes in for steady-state; these are long runs by nature.
 */

import React, { useCallback, useRef, useState } from 'react';
import { Button, ScrollView, StyleSheet, Text, View } from 'react-native';

import { buildGrammar } from '../llm/grammar/buildGrammar';
import { TASK_EXTRACTION_V1_GBNF } from '../llm/grammar/grammarText';
import { validateTaskExtraction } from '../llm';
import { assembleExtractionPrompt } from '../llm/prompts/assemble';
import { buildExtractionRecapInstruction } from '../llm/prompts/systemPrompts';
import { TernaryBonsaiProvider } from '../llm/provider/ternaryBonsaiProvider';
import { runConstrained, type ChatMessage } from '../llm/provider';
import { EXTRACTION_FIXTURES } from './extractionFixturesData';
import {
  scoreExtraction,
  summarize,
  type ExtractionFixture,
  type ScoreResult,
} from './extractionScoring';

const CONTEXT_TAGS_KNOWN = ['home', 'office', 'phone', 'computer'];
const EXTRACTION_MAX_TOKENS = 200;

/** The Q1/task-6 subset — 2 simple + the null-vs-unscheduled trap + a date case. */
const QUICK_IDS = ['simple-scheduled-01', 'oneoff-null-01', 'trap-unsched-01', 'date-weekday-01'];

/** Fixtures whose gold says a clarifying question is acceptable — the ask-don't-guess probe set. */
const AMBIGUOUS_IDS = EXTRACTION_FIXTURES.filter((f) => f.gold.clarify_ok.length > 0).map((f) => f.id);

function logResultJson(tag: string, value: unknown): void {
  const json = JSON.stringify(value);
  const CHUNK = 3000;
  const total = Math.max(1, Math.ceil(json.length / CHUNK));
  for (let i = 0; i < total; i++) {
    console.log(`[${tag} ${i + 1}/${total}] ${json.slice(i * CHUNK, (i + 1) * CHUNK)}`);
  }
}

/** The conversation for a fixture: its turns, plus its clarify_answers flattened as trailing user
 *  turns (the Q1 convention). This models the POST-clarification state, which is what `gold`
 *  encodes — the question itself is the Ask probe's business, not this one's. */
function conversationFor(fixture: ExtractionFixture, includeClarify: boolean): ChatMessage[] {
  return [
    ...fixture.turns.map((t) => ({ role: 'user' as const, content: t.content })),
    ...(includeClarify
      ? fixture.clarify_answers.map((a) => ({ role: 'user' as const, content: a }))
      : []),
  ];
}

/** Heuristic: did the prose turn actually ASK something? A question mark is the honest signal; the
 *  surrounding text is logged in full so a human can judge the borderline cases. */
function looksLikeQuestion(text: string): boolean {
  return text.includes('?');
}

export default function Task7PromptScreen() {
  const [log, setLog] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const providerRef = useRef<TernaryBonsaiProvider | null>(null);

  const append = useCallback((line: string) => {
    setLog((prev) => [...prev, line]);
    console.log('[T7]', line);
  }, []);

  const ensureProvider = useCallback(async (): Promise<TernaryBonsaiProvider> => {
    if (providerRef.current?.isAvailable()) return providerRef.current;
    const provider = providerRef.current ?? new TernaryBonsaiProvider();
    providerRef.current = provider;
    const start = Date.now();
    append('Loading model ...');
    await provider.load();
    append(`Model loaded in ${Date.now() - start}ms`);
    return provider;
  }, [append]);

  const withRun = useCallback(
    (fn: () => Promise<void>) => async () => {
      setRunning(true);
      try {
        await fn();
      } catch (err: any) {
        append(`UNEXPECTED ERROR: ${String(err?.message ?? err)}`);
      } finally {
        setRunning(false);
      }
    },
    [append],
  );

  /** One scored run over `fixtures` through the real prompt + grammar + ladder. */
  const runScored = useCallback(
    async (label: string, fixtures: ExtractionFixture[]) => {
      const provider = await ensureProvider();
      const grammar = buildGrammar(TASK_EXTRACTION_V1_GBNF, {
        context_tags_known: CONTEXT_TAGS_KNOWN,
      });
      append(`[${label}] ${fixtures.length} fixtures through the REAL task-7 prompt ...`);

      const scores: ScoreResult[] = [];
      const perFixture: Array<Record<string, unknown>> = [];
      let validCount = 0;

      for (const fixture of fixtures) {
        const messages = assembleExtractionPrompt({
          todayISO: fixture.today,
          conversation: conversationFor(fixture, true),
        });
        try {
          const result = await runConstrained({
            provider,
            messages,
            grammar,
            maxTokens: EXTRACTION_MAX_TOKENS,
            validate: (raw) => validateTaskExtraction(raw, fixture.today),
          });

          if (result.status !== 'ok') {
            append(`  ✗ ${fixture.id}: INVALID after ${result.attempts} attempts — ${result.error.message}`);
            perFixture.push({ id: fixture.id, valid: false, error: result.error.message });
            continue;
          }

          validCount++;
          const score = scoreExtraction(result.raw as Record<string, unknown>, fixture);
          scores.push(score);
          const mark = score.criticalCorrect ? '✓' : '✗';
          const wrong = score.fields.filter((f) => f.verdict === 'wrong').map((f) => f.field);
          append(
            `  ${mark} ${fixture.id}: critical=${score.criticalCorrect ? 'OK' : score.criticalFailures.join(',')}` +
              ` wrong=[${wrong.join(',')}]${score.junkTags.length ? ` junk=[${score.junkTags.join('|')}]` : ''}`,
          );
          perFixture.push({
            id: fixture.id,
            valid: true,
            attempts: result.attempts,
            extraction: result.raw,
            score,
          });
        } catch (err: any) {
          append(`  ✗ ${fixture.id} ERROR: ${String(err?.message ?? err)}`);
          perFixture.push({ id: fixture.id, valid: false, error: String(err?.message ?? err) });
        }
      }

      const summary = summarize(scores, fixtures.length, validCount);
      append(
        `[${label}] KPI — valid ${summary.validCount}/${summary.total}, ` +
          `CRITICAL-CORRECT ${summary.criticalCorrectCount}/${summary.total}, ` +
          `fully-correct ${summary.fullyCorrectCount}/${summary.total}, junk tags ${summary.junkTagCount}`,
      );
      const worst = Object.entries(summary.fieldFailures).sort((a, b) => b[1] - a[1]);
      append(`[${label}] field failures: ${worst.map(([f, n]) => `${f}=${n}`).join(' ') || 'none'}`);
      logResultJson(`T7RESULT:${label}`, { summary, perFixture });
    },
    [append, ensureProvider],
  );

  const runQuick = withRun(async () => {
    await runScored('quick4', EXTRACTION_FIXTURES.filter((f) => QUICK_IDS.includes(f.id)));
  });

  const runFull = withRun(async () => {
    await runScored('full16', EXTRACTION_FIXTURES);
  });

  /** D6 ask-don't-guess: ambiguous input, NO clarify answer, unconstrained prose turn. */
  const runAskProbe = withRun(async () => {
    const provider = await ensureProvider();
    const fixtures = EXTRACTION_FIXTURES.filter((f) => AMBIGUOUS_IDS.includes(f.id));
    append(`[ask] ${fixtures.length} ambiguous fixtures, clarify_answers WITHHELD, prose turn ...`);
    const results: Array<Record<string, unknown>> = [];

    for (const fixture of fixtures) {
      const messages: ChatMessage[] = [
        ...assembleExtractionPrompt({
          todayISO: fixture.today,
          conversation: conversationFor(fixture, false),
        }),
        { role: 'system', content: buildExtractionRecapInstruction() },
      ];
      try {
        // Prose turn: no grammar. Temperature 0 so the probe is reproducible.
        const res = await provider.generateResponse(messages, { maxTokens: 120, temperature: 0 });
        const text = res.text.trim();
        const asked = looksLikeQuestion(text);
        append(`  ${asked ? '✓ ASKED' : '✗ no question'} ${fixture.id}: ${JSON.stringify(text.slice(0, 160))}`);
        results.push({ id: fixture.id, clarifyOk: fixture.gold.clarify_ok, asked, text });
      } catch (err: any) {
        append(`  ✗ ${fixture.id} ERROR: ${String(err?.message ?? err)}`);
        results.push({ id: fixture.id, error: String(err?.message ?? err) });
      }
    }

    const askedCount = results.filter((r) => r.asked === true).length;
    append(`[ask] KPI — asked a question on ${askedCount}/${fixtures.length} ambiguous inputs`);
    logResultJson('T7RESULT:ask', { askedCount, total: fixtures.length, results });
  });

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ paddingBottom: 32 }}>
      <Text style={styles.title}>Task 7 — Prompt Tuning (S23 FE)</Text>
      <Text style={styles.note}>KPI: valid-AND-correct vs each fixture's gold. Edit fieldGuides.ts → reload → re-run.</Text>
      <Button title="Quick (4) — fast iteration" onPress={runQuick} disabled={running} />
      <View style={styles.gap} />
      <Button title="Full (16) — the KPI" onPress={runFull} disabled={running} />
      <View style={styles.gap} />
      <Button title="Ask-don't-guess probe (prose)" onPress={runAskProbe} disabled={running} />
      <View style={styles.gap} />
      {log.map((line, i) => (
        <Text key={i} style={styles.logLine}>{line}</Text>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16 },
  title: { fontSize: 16, fontWeight: '600', marginBottom: 4 },
  note: { fontSize: 11, marginBottom: 12, opacity: 0.7 },
  gap: { height: 8 },
  logLine: { fontFamily: 'monospace', fontSize: 11, marginBottom: 2 },
});
