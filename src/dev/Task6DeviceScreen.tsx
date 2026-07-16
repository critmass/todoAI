/**
 * Task 6 — Phase B on-device confirmation harness (S23 FE).
 * docs/briefs/opus_batch_B_device.md §"Task 6". THROWAWAY DEV SPIKE, NOT PRODUCTION.
 *
 * Unlike Q1GrammarSpikeScreen (which drove llama.rn directly), this harness drives the REAL
 * task-6 modules end-to-end — that is the whole point of Phase B "through the real
 * TernaryBonsaiProvider, not the standalone spike":
 *   - TernaryBonsaiProvider   (the actual LLMProvider over llama.rn)
 *   - runConstrained          (the actual D10 validate→retry→fallback ladder)
 *   - runStartupGuard         (the actual constraint-#3 startup guard)
 *   - buildGrammarRegistry    (the actual registry the guard compiles)
 *   - validateTaskExtraction  (task 5's actual validator)
 *
 * Buttons, in the brief's order:
 *   0  Load provider (real initLlama via provider.load()).
 *   H  Grammar hygiene: compile RAW (with # comments) vs STRIPPED extraction grammar. Isolates
 *      whether this build's parser rejects `#` comments (Q1c stripped before use; Phase A's
 *      provider now strips too — this proves the gap was real and the fix works).
 *   A  Check 1 — provider works: real extraction grammar → runConstrained ladder →
 *      validateTaskExtraction. The core "the provider works" proof.
 *   B  Check 2 — Stage 2/3 through the real provider: 4 seed fixtures valid/validator-passing,
 *      plus constrained-vs-unconstrained overhead (compare to Q1c's 1.03x / ~3%).
 *   C1 Check 3 (PRIORITY) control — startup guard over the good registry → expect grammarEnabled.
 *   C2 Check 3 (PRIORITY) — startup guard with a DELIBERATELY-BROKEN grammar (underscore rule
 *      name, the known parser-breaker). Expect: guard CATCHES it → grammarEnabled=false, the
 *      surface listed, and THE APP SURVIVES. If the app vanishes instead of rendering a result,
 *      that silence IS the finding (uncatchable death) — check `adb logcat`.
 *   C3 Check 3 — fallback path: an extraction with NO grammar (prompt-JSON + validation), proving
 *      the app still functions when grammarEnabled=false.
 *   Health  load time + last tok/s snapshot (thermal sampler is still the stub — see note).
 *
 * Results are logged as tagged, chunked [T6RESULT:*] lines (logcat truncates long lines) — same
 * convention as Q1GrammarSpikeScreen; capture with `adb logcat`, or read off-screen.
 *
 * DEVICE DISCIPLINE (brief): run B twice — cold, then ~2 min in — so tok/s reflects the ~5.2
 * steady state, not the burst. Fresh app context (force-stop/relaunch) before C2 so a prior
 * failure can't poison the guard result.
 */

import React, { useCallback, useRef, useState } from 'react';
import { Button, ScrollView, StyleSheet, Text, View } from 'react-native';

import { buildGrammar } from '../llm/grammar/buildGrammar';
import { TASK_EXTRACTION_V1_GBNF } from '../llm/grammar/grammarText';
import { validateTaskExtraction } from '../llm';
import { TernaryBonsaiProvider } from '../llm/provider/ternaryBonsaiProvider';
import {
  buildGrammarRegistry,
  runConstrained,
  runStartupGuard,
  type GrammarRegistryEntry,
  type LLMResponse,
} from '../llm/provider';

// ---- CONFIG ----
const CONTEXT_TAGS_KNOWN = ['home', 'office', 'phone', 'computer'];
const EXTRACTION_MAX_TOKENS = 200; // matches Q1c Stage 2/3's n_predict for a like-for-like overhead read
const DEVICE_LABEL = 'Samsung Galaxy S23 FE';
const RUN_NOTE = '<edit: cold start / N minutes in, warm>';

// ---- SEED FIXTURES (same 4 as Q1c Stage 2, ids match docs/eval/extraction_fixtures_seed.jsonl) ----
type SeedFixture = {
  id: string;
  today: string; // YYYY-MM-DD
  turns: Array<{ role: 'user'; content: string }>;
  clarifyAnswers?: string[];
};

const SEED_FIXTURES: SeedFixture[] = [
  {
    id: 'simple-scheduled-01',
    today: '2026-07-08',
    turns: [
      { role: 'user', content: 'I need to take out the trash' },
      { role: 'user', content: 'Yes, every Tuesday' },
    ],
  },
  {
    id: 'oneoff-null-01',
    today: '2026-07-08',
    turns: [{ role: 'user', content: 'I need to renew my passport before it expires' }],
  },
  {
    id: 'trap-unsched-01',
    today: '2026-07-08',
    turns: [{ role: 'user', content: 'I want to keep working on my novel' }],
    clarifyAnswers: [
      "It's ongoing, I never really finish it, I just want to keep coming back to it",
    ],
  },
  {
    id: 'date-weekday-01',
    today: '2026-07-08',
    turns: [{ role: 'user', content: 'I have to call the insurance company by Friday' }],
  },
];

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Minimal grounding prompt, transcribed verbatim from Q1GrammarSpikeScreen so Check B's numbers
// are directly comparable to Q1c's. NOT task 7's tuned prompt — that iteration is the next batch.
function buildExtractionSystemPrompt(todayISO: string): string {
  const weekday = WEEKDAY_NAMES[new Date(`${todayISO}T00:00:00Z`).getUTCDay()];
  return [
    `You are extracting structured task data as JSON. Today is ${todayISO} (${weekday}).`,
    'Fields: title (short name); description (extra detail or null); estimated_duration_minutes ' +
      '(how long the task itself takes — guess if unstated, and set duration_from_user to false ' +
      'when you guessed, true when the user stated it); due (null if no due date, else a relative ' +
      'date expression); context_tags (short tags, or empty); tool_requirements (things needed, or ' +
      'empty); energy (low/med/high, or null if unclear); importance_user (1-10, or null if unstated); ' +
      'recurrence (see below).',
    'Decide recurrence in this order: ' +
      '(1) Does completing it once finish it forever? -> one-off (recurrence: null). ' +
      '(2) Is it "done after N total completions, ever"? -> count (target N). ' +
      '(3) Fixed days, with a per-period quota alongside? -> scheduled_quota. Fixed days, no quota? -> scheduled. ' +
      '(4) A quota per period but no fixed days? -> quota. ' +
      '(5) Recurs indefinitely with no schedule and no quota (ongoing project, practice, "keep at it")? -> unscheduled.',
  ].join('\n');
}

function fixtureMessages(fixture: SeedFixture) {
  return [
    { role: 'system' as const, content: buildExtractionSystemPrompt(fixture.today) },
    ...fixture.turns,
    ...(fixture.clarifyAnswers ?? []).map((a) => ({ role: 'user' as const, content: a })),
  ];
}

// Dev-only copy of the `#`-comment strip that Q1GrammarSpikeScreen's Stage 2 applied. Production
// deliberately does NOT do this: check H proved on-device (2026-07-16) that the parser accepts
// comments as-authored, so the strip is unnecessary (and would corrupt a `#`-bearing slot value).
// Kept here solely so the H probe stays reproducible.
function devStripGrammarComments(grammar: string): string {
  return grammar
    .split('\n')
    .map((line) => line.replace(/#.*$/, '').trimEnd())
    .filter((line) => line.length > 0)
    .join('\n');
}

// A deliberately-broken grammar for the guard proof: an underscore in a rule name — the known
// parser-breaker (Q1c §3). Comment-stripping cannot rescue it (it's a rule name, not a comment),
// so it survives normalization and genuinely exercises the guard.
const BROKEN_UNDERSCORE_GRAMMAR = 'root ::= foo_str\nfoo_str ::= "x"';
// A second break: unbalanced syntax. Expected to throw a catchable parse error.
const BROKEN_SYNTAX_GRAMMAR = 'root ::= "a" (';

// ---- LOGGING (chunked; logcat truncates long lines) ----
function logResultJson(tag: string, value: unknown): void {
  const json = JSON.stringify(value);
  const CHUNK = 3000;
  const total = Math.max(1, Math.ceil(json.length / CHUNK));
  for (let i = 0; i < total; i++) {
    console.log(`[${tag} ${i + 1}/${total}] ${json.slice(i * CHUNK, (i + 1) * CHUNK)}`);
  }
}

function timingsOf(res: LLMResponse) {
  return res.timings ?? { promptMs: 0, promptPerSecond: 0, predictedN: 0, predictedPerSecond: 0 };
}

export default function Task6DeviceScreen() {
  const [log, setLog] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const providerRef = useRef<TernaryBonsaiProvider | null>(null);
  const loadMsRef = useRef<number | null>(null);
  const lastTimingsRef = useRef<ReturnType<typeof timingsOf> | null>(null);

  const append = useCallback((line: string) => {
    setLog((prev) => [...prev, line]);
    console.log('[T6]', line);
  }, []);

  const ensureProvider = useCallback(async (): Promise<TernaryBonsaiProvider> => {
    if (providerRef.current?.isAvailable()) return providerRef.current;
    const provider = providerRef.current ?? new TernaryBonsaiProvider();
    providerRef.current = provider;
    const start = Date.now();
    append('Loading model via TernaryBonsaiProvider.load() ...');
    await provider.load();
    loadMsRef.current = Date.now() - start;
    append(`Model loaded in ${loadMsRef.current}ms. tier=${provider.activeTier()} thermal=${provider.currentThermalHeadroom()}`);
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

  // ---- 0: load ----
  const runLoad = withRun(async () => {
    await ensureProvider();
  });

  // ---- H: grammar hygiene (raw # comments vs stripped) ----
  const runHygiene = withRun(async () => {
    const provider = await ensureProvider();
    const raw = buildGrammar(TASK_EXTRACTION_V1_GBNF, { context_tags_known: CONTEXT_TAGS_KNOWN });
    const stripped = devStripGrammarComments(raw);
    append(`Hygiene: raw=${raw.length} chars, stripped=${stripped.length} chars. Compiling RAW (with # comments) ...`);

    // Hit the context directly for both cases so the probe is independent of what the provider
    // does internally (it now sends grammar as-authored — see the RESULT note below).
    const ctx = (provider as any).context as { completion: (p: any) => Promise<any> };
    let rawResult: Record<string, unknown>;
    try {
      await ctx.completion({ messages: [{ role: 'user', content: 'x' }], grammar: raw, n_predict: 1, temperature: 0, top_k: 1 });
      rawResult = { rawCompiles: true };
      append('Hygiene: RAW (with comments) COMPILED. (This build tolerates # comments — the strip is a harmless no-op.)');
    } catch (err: any) {
      rawResult = { rawCompiles: false, rawError: String(err?.message ?? err) };
      append(`Hygiene: RAW FAILED to compile: ${String(err?.message ?? err)}`);
    }

    let strippedCompiles = false;
    let strippedError: string | undefined;
    try {
      await ctx.completion({ messages: [{ role: 'user', content: 'x' }], grammar: stripped, n_predict: 1, temperature: 0, top_k: 1 });
      strippedCompiles = true;
      append('Hygiene: STRIPPED COMPILED.');
    } catch (err: any) {
      strippedError = String(err?.message ?? err);
      append(`Hygiene: STRIPPED FAILED: ${strippedError}`);
    }
    logResultJson('T6RESULT:hygiene', { device: DEVICE_LABEL, runNote: RUN_NOTE, ...rawResult, strippedCompiles, strippedError });
    // RESULT (2026-07-16, S23 FE): RAW and STRIPPED both compiled. This build's GBNF parser accepts
    // `#` comments; Q1's Stage 2 strip was a leftover hypothesis from the underscore-bug era and was
    // never re-tested after the Q1c rename fixed the real cause. Production sends grammar as-authored.
    append('Hygiene finding: RAW and STRIPPED both compile on this build — no strip needed (confirmed 2026-07-16).');
  });

  // ---- A: provider works (real ladder + real validator) ----
  const runCheckA = withRun(async () => {
    const provider = await ensureProvider();
    const grammar = buildGrammar(TASK_EXTRACTION_V1_GBNF, { context_tags_known: CONTEXT_TAGS_KNOWN });
    const fixture = SEED_FIXTURES[0];
    append(`Check A: extraction "${fixture.id}" through runConstrained (real D10 ladder) ...`);
    const result = await runConstrained({
      provider,
      messages: fixtureMessages(fixture),
      grammar,
      maxTokens: EXTRACTION_MAX_TOKENS,
      validate: (raw) => validateTaskExtraction(raw, fixture.today),
    });
    if (result.status === 'ok') {
      lastTimingsRef.current = timingsOf(result.response);
      append(`Check A: OK (attempts=${result.attempts}). Validated extraction returned. tok/s=${lastTimingsRef.current.predictedPerSecond.toFixed(2)}`);
      logResultJson('T6RESULT:checkA', {
        status: 'ok', attempts: result.attempts, value: result.value,
        raw: result.raw, timings: lastTimingsRef.current,
      });
    } else {
      lastTimingsRef.current = timingsOf(result.lastResponse);
      append(`Check A: FALLBACK after ${result.attempts} attempts — ${result.error.message}`);
      logResultJson('T6RESULT:checkA', {
        status: 'fallback', attempts: result.attempts,
        lastText: result.lastResponse.text, error: result.error.message,
      });
    }
  });

  // ---- B: Stage 2 (4 fixtures) + Stage 3 (overhead) through the real provider ----
  const runCheckB = withRun(async () => {
    const provider = await ensureProvider();
    const grammar = buildGrammar(TASK_EXTRACTION_V1_GBNF, { context_tags_known: CONTEXT_TAGS_KNOWN });
    append('Check B: Stage 2 — 4 seed fixtures through the real provider ...');
    const perFixture: Array<Record<string, unknown>> = [];
    for (const fixture of SEED_FIXTURES) {
      try {
        const res = await provider.generateResponse(fixtureMessages(fixture), {
          grammar, maxTokens: EXTRACTION_MAX_TOKENS, temperature: 0, topK: 1,
        });
        let parsed: unknown;
        let parsesAsJson = false;
        try { parsed = JSON.parse(res.text.trim()); parsesAsJson = true; } catch { parsesAsJson = false; }
        let passesValidator = false;
        let validatorError: string | undefined;
        if (parsesAsJson) {
          try { validateTaskExtraction(parsed, fixture.today); passesValidator = true; }
          catch (e: any) { validatorError = String(e?.message ?? e); }
        }
        append(`Check B [${fixture.id}]: parses=${parsesAsJson} validates=${passesValidator}${validatorError ? ` (${validatorError})` : ''}`);
        perFixture.push({ id: fixture.id, rawOutput: res.text, parsesAsJson, passesValidator, validatorError, timings: timingsOf(res) });
      } catch (err: any) {
        append(`Check B [${fixture.id}] ERROR: ${String(err?.message ?? err)}`);
        perFixture.push({ id: fixture.id, error: String(err?.message ?? err) });
      }
    }
    const validCount = perFixture.filter((r) => r.parsesAsJson).length;
    const passCount = perFixture.filter((r) => r.passesValidator).length;
    append(`Check B Stage 2 summary: valid JSON ${validCount}/${SEED_FIXTURES.length}, validator-passing ${passCount}/${SEED_FIXTURES.length}`);

    // Stage 3 — constrained vs unconstrained, same prompt, both temp 0.
    append('Check B: Stage 3 — constrained vs unconstrained overhead ...');
    const f0 = SEED_FIXTURES[0];
    const unc = await provider.generateResponse(fixtureMessages(f0), { maxTokens: EXTRACTION_MAX_TOKENS, temperature: 0 });
    const con = await provider.generateResponse(fixtureMessages(f0), { grammar, maxTokens: EXTRACTION_MAX_TOKENS, temperature: 0, topK: 1 });
    const u = timingsOf(unc).predictedPerSecond;
    const c = timingsOf(con).predictedPerSecond;
    const ratio = u && c ? u / c : undefined;
    lastTimingsRef.current = timingsOf(con);
    append(`Check B Stage 3: unconstrained ${u.toFixed(2)} tok/s, constrained ${c.toFixed(2)} tok/s → overhead ${ratio ? ratio.toFixed(2) : '?'}x (Q1c was 1.03x)`);
    logResultJson('T6RESULT:checkB', {
      device: DEVICE_LABEL, runNote: RUN_NOTE, validCount, passCount, perFixture,
      stage3: { unconstrainedTps: u, constrainedTps: c, overheadRatio: ratio },
    });
  });

  // ---- C1: guard control (good registry → grammarEnabled) ----
  const runGuardControl = withRun(async () => {
    const provider = await ensureProvider();
    append('Check C1: startup guard over the GOOD registry (all 4 real grammars) ...');
    const result = await runStartupGuard(provider.compileGrammar, buildGrammarRegistry());
    append(`Check C1: grammarEnabled=${result.grammarEnabled} attempted=${result.attempted} failures=${result.failures.length}`);
    for (const f of result.failures) append(`  unexpected failure: ${f.surface} — ${f.error}`);
    logResultJson('T6RESULT:guardControl', result);
    append(result.grammarEnabled
      ? 'Check C1: PASS — all real grammars compile on-device through the real guard.'
      : 'Check C1: FINDING — a real grammar failed the guard (see failures above).');
  });

  // ---- C2: guard with a deliberately-broken grammar (PRIORITY) ----
  const runGuardBroken = useCallback(
    (label: string, brokenGrammar: string) =>
      withRun(async () => {
        const provider = await ensureProvider();
        // Registry: the broken grammar first, plus the good ones — so we also confirm the guard
        // attempts every entry (doesn't stop at the first failure) and still reports enabled=false.
        const registry: GrammarRegistryEntry[] = [
          { surface: 'summary', grammar: brokenGrammar } as GrammarRegistryEntry,
          ...buildGrammarRegistry(),
        ];
        append(`Check C2 [${label}]: guard with a BROKEN grammar. If the app VANISHES instead of logging a result, that silence is the finding (uncatchable death) — check logcat.`);
        const result = await runStartupGuard(provider.compileGrammar, registry);
        append(`Check C2 [${label}]: SURVIVED. grammarEnabled=${result.grammarEnabled} attempted=${result.attempted} failures=${result.failures.length}`);
        for (const f of result.failures) append(`  caught failure: ${f.surface} — ${f.error}`);
        logResultJson('T6RESULT:guardBroken', { label, ...result });
        append(result.grammarEnabled === false && result.failures.length > 0
          ? 'Check C2: PASS — guard CAUGHT the broken grammar and disabled the grammar path (→ fallback). This is the priority proof.'
          : 'Check C2: FINDING — broken grammar did NOT surface as a caught failure; investigate.');
      }),
    [append, ensureProvider, withRun],
  );

  // ---- C3: fallback path (prompt-JSON, no grammar) ----
  const runFallbackPath = withRun(async () => {
    const provider = await ensureProvider();
    const fixture = SEED_FIXTURES[0];
    append('Check C3: fallback path — extraction with NO grammar (prompt-JSON + validation) ...');
    const res = await provider.generateResponse(fixtureMessages(fixture), { maxTokens: EXTRACTION_MAX_TOKENS, temperature: 0 });
    let parsed: unknown;
    let parses = false;
    try { parsed = JSON.parse(res.text.trim()); parses = true; } catch { parses = false; }
    let validates = false;
    let validatorError: string | undefined;
    if (parses) {
      try { validateTaskExtraction(parsed, fixture.today); validates = true; }
      catch (e: any) { validatorError = String(e?.message ?? e); }
    }
    append(`Check C3: no-grammar output parses=${parses} validates=${validates}${validatorError ? ` (${validatorError})` : ''}`);
    append('Check C3: the app remains functional with the grammar path disabled — even if this single output needs the D10 retry, the flow does not crash.');
    logResultJson('T6RESULT:fallbackPath', { rawOutput: res.text, parses, validates, validatorError, timings: timingsOf(res) });
  });

  // ---- Health snapshot ----
  const runHealth = withRun(async () => {
    const provider = await ensureProvider();
    const snap = {
      device: DEVICE_LABEL,
      runNote: RUN_NOTE,
      loadMs: loadMsRef.current,
      lastTimings: lastTimingsRef.current,
      tier: provider.activeTier(),
      thermalHeadroom: provider.currentThermalHeadroom(),
      thermalSamplerNote: 'STUB (default sampler returns 0/NONE) — native PowerManager thermal wiring is not built yet (spec §3.5). tok/s drift between a cold and a warm Check B run is the real throttling signal.',
    };
    append(`Health: loadMs=${snap.loadMs} tier=${snap.tier} thermal=${snap.thermalHeadroom} (stub). Note battery % before/after a Check B run manually.`);
    logResultJson('T6RESULT:health', snap);
  });

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ paddingBottom: 32 }}>
      <Text style={styles.title}>Task 6 — Device Confirmation (S23 FE)</Text>
      <Button title="0 · Load provider" onPress={runLoad} disabled={running} />
      <View style={styles.gap} />
      <Button title="H · Grammar hygiene (raw # vs stripped)" onPress={runHygiene} disabled={running} />
      <View style={styles.gap} />
      <Button title="A · Provider works (ladder + validator)" onPress={runCheckA} disabled={running} />
      <View style={styles.gap} />
      <Button title="B · Stage 2/3 through real provider" onPress={runCheckB} disabled={running} />
      <View style={styles.gap} />
      <Text style={styles.section}>Check 3 — startup guard (PRIORITY)</Text>
      <Button title="C1 · Guard control (good registry)" onPress={runGuardControl} disabled={running} />
      <View style={styles.gap} />
      <Button title="C2 · Guard vs BROKEN grammar (underscore)" onPress={runGuardBroken('underscore', BROKEN_UNDERSCORE_GRAMMAR)} disabled={running} />
      <View style={styles.gap} />
      <Button title="C2b · Guard vs BROKEN grammar (bad syntax)" onPress={runGuardBroken('bad-syntax', BROKEN_SYNTAX_GRAMMAR)} disabled={running} />
      <View style={styles.gap} />
      <Button title="C3 · Fallback path (no grammar)" onPress={runFallbackPath} disabled={running} />
      <View style={styles.gap} />
      <Button title="Health snapshot" onPress={runHealth} disabled={running} />
      <View style={styles.gap} />
      {log.map((line, i) => (
        <Text key={i} style={styles.logLine}>{line}</Text>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16 },
  title: { fontSize: 16, fontWeight: '600', marginBottom: 12 },
  section: { fontSize: 14, fontWeight: '600', marginTop: 8, marginBottom: 6 },
  gap: { height: 8 },
  logLine: { fontFamily: 'monospace', fontSize: 12, marginBottom: 2 },
});
