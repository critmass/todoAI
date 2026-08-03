/**
 * Model-base spike harness — S23 FE
 * docs/briefs/model_base_spike_qwen35.md (gates 0–2), same discipline as the Q1 arc.
 *
 * THROWAWAY DEV SPIKE, NOT PRODUCTION CODE. Nothing here is wired into the app: no
 * LLMProvider, no TernaryBonsaiProvider, no production import beyond types. It answers
 * one question — is there a point on the Qwen precision ladder that fits the S23 FE's
 * thermal-and-memory envelope and could serve a LoRA later.
 *
 * Split into its own screen rather than growing Q1GrammarSpikeScreen.tsx further — same
 * convention DateStrProbeScreen/RuleNameProbeScreen followed. The model-load path is
 * cribbed from Q1GrammarSpikeScreen.tsx (initLlama config, loadLlamaModelInfo diagnostic,
 * greedy completion params); a small, intentional duplication for a throwaway probe.
 *
 * ONE CORRECTION TO THE BRIEF'S PREMISE, recorded here so it isn't re-litigated on-device:
 * the brief's §0 assumes Qwen3.5 is the same architecture as Bonsai ("qwen3") at a higher
 * precision. It is not. Bonsai's GGUF reports arch `qwen3` (dense attention); Qwen3.5
 * dense reports arch `qwen35`, which this pinned llama.rn build classifies as a HYBRID
 * architecture (`llm_arch_is_hybrid` -> true, alongside qwen3next/kimi-linear), with a
 * separate model class and an MTP head. Same vendor lineage, different architecture. That
 * makes Gate 0 a real test rather than a formality, and means Gate 1's memory number will
 * not scale from parameter count the way a dense Q4 would (hybrid models carry a recurrent
 * state alongside the KV cache, and this build inflates the graph node budget for them).
 *
 * WHAT THIS SCREEN COVERS: Gate 0 (header reads / model loads) and Gate 1 (load time,
 * tok/s burst + sustained). Gate 2 (GBNF + extraction quality) is deliberately NOT here
 * yet — it is only worth building if 0 and 1 pass.
 *
 * PEAK RAM IS NOT MEASURED FROM JS. There is no filesystem/proc native module in this
 * project and adding one would be a second untested native module. Measure it host-side:
 *   adb shell dumpsys meminfo com.todoai
 * taken (a) before load, (b) right after load, (c) at the end of the Gate 1 loop.
 *
 * Results are logged as tagged, chunked JSON — same convention as the Q1 screens, so
 * scripts/q1-reassemble.js can pull them. Capture with `adb logcat`, or read straight off
 * the on-screen log. Tags are `MBRESULT:<model>:g<gate>:r<seq>`: that reassembler keys its
 * output by tag and a repeated tag silently overwrites, so every result gets a unique one.
 *
 * BEFORE RUNNING:
 *  1. Push the GGUF to /sdcard/Android/data/com.todoai/files/ and make sure its filename
 *     matches the MODELS entry below.
 *  2. Fill in that entry's sha256 (adb shell sha256sum <path>) and RUN_NOTE.
 *  3. Pick the model with the top row of buttons, then run Gate 0a -> 0b -> Gate 1.
 *     Stop and report if 0a or 0b hard-fails; a no is a complete answer.
 */

import React, { useCallback, useRef, useState } from 'react';
import { Button, ScrollView, StyleSheet, Text, View } from 'react-native';
import {
  initLlama,
  loadLlamaModelInfo,
  type LlamaContext,
  type RNLlamaOAICompatibleMessage,
} from 'llama.rn';

// ---- CONFIG ----

type SpikeModel = {
  key: string;
  label: string;
  filename: string;
  /** adb shell sha256sum <path>. '<unset>' until the file has actually been pushed. */
  sha256: string;
  note: string;
};

/** The three rungs the brief compares. Bonsai stays first so the baseline can be re-measured
 *  on the same build, same day, same thermal conditions as the challengers — the brief's
 *  numbers for it were taken in a different session and are not strictly comparable. */
const MODELS: SpikeModel[] = [
  {
    key: 'bonsai4b',
    label: 'Bonsai-4B TQ1_0 (baseline)',
    filename: 'Ternary-Bonsai-4B-TQ1_0.gguf',
    sha256: 'da1f7ecd5aba89d920589b23e205d0212830b492dc3f8326638dc13b8c45431c',
    note: 'arch qwen3, dense. The incumbent.',
  },
  {
    key: 'qwen2b',
    label: 'Qwen3.5-2B Q4_K_M',
    filename: 'Qwen3.5-2B-Q4_K_M.gguf',
    sha256: 'aaf42c8b7c3cab2bf3d69c355048d4a0ee9973d48f16c731c0520ee914699223',
    note: 'arch qwen35, hybrid. Quality-ceiling probe: bigger/hotter than the incumbent.',
  },
  {
    key: 'qwen08b',
    label: 'Qwen3.5-0.8B Q4_K_M',
    filename: 'Qwen3.5-0.8B-Q4_K_M.gguf',
    sha256: '<unset - paste adb shell sha256sum output>',
    note: 'arch qwen35, hybrid. The rung most likely to fit the envelope.',
  },
];

const modelPath = (m: SpikeModel) => `file:///sdcard/Android/data/com.todoai/files/${m.filename}`;

/** Module-level so the manifest builder can read it without threading it through every
 *  callback — acceptable in a throwaway spike; the picker keeps it in sync with the UI. */
let activeModel: SpikeModel = MODELS[0];

// Same CPU-only baseline as the Q1 harness. n_gpu_layers stays 0: the Adreno 730 OpenCL path
// didn't cover TQ1_0, and holding it at 0 is also what keeps the challengers comparable to the
// baseline. A GPU-offload variant would be a separate, later measurement.
const N_CTX = 2048;
const N_THREADS = 4;
const N_GPU_LAYERS = 0;

// ---- MANIFEST FIELDS (strategy §6.6: "a number without its manifest is a rumor") ----
const LLAMA_RN_VERSION = '0.12.5'; // pinned in package.json
const DEVICE_LABEL = 'Samsung Galaxy S23 FE';
// Edit before each run. Thermal state is the whole point of Gate 1 — a burst number taken on a
// cold phone and a steady number taken on a hot one are different measurements.
// NOTE ON EARLIER TAGS: results r0-r8 all carry the FIRST version of this string ("phone idle
// and cool at the start of the run"), because Metro's HMR socket to the device died during the
// first sustained loop — the JS thread stops answering its heartbeat under a 4.5-minute decode,
// Metro drops the connection, and every later edit to this file silently failed to reach the
// running app. Those embedded notes are therefore stale and understate the conditions; the real
// per-run conditions are recorded in docs/eval/qwen35_spike_run_conditions.md. Reload the app
// (not just save the file) after any sustained run before trusting a manifest edit.
const RUN_NOTE =
  '2026-08-03, debug build over the personal release install, USB-powered throughout, phone ' +
  'OUT of its case. Cooldown to ~31C between runs. Applies to tags from r9 onward; r0-r8 carry ' +
  'a stale note (see docs/eval/qwen35_spike_run_conditions.md). Gate 0 is cold; Gate 1 starts ' +
  'warm because Gate 0b precedes it.';

// ---- GATE 1 PARAMETERS ----

/** Sustained-decode duration. The brief asks for >= 4 min; 4.5 gives margin so the last
 *  window is a full one. */
const SUSTAIN_MS = 4.5 * 60 * 1000;
/** The long run. 4.5 min was enough to show Bonsai plateau but not enough for the 2B, whose
 *  curve was still descending at cutoff — so its floor, the number the envelope question
 *  actually turns on, went unmeasured. 20 min is long enough for the SoC's thermal governor
 *  to reach its own steady state rather than the measurement window's. */
const SUSTAIN_LONG_MS = 20 * 60 * 1000;
/** Tokens per iteration. Big enough that per-call overhead doesn't dominate the tok/s figure,
 *  small enough that the loop can stop promptly and report per-iteration drift. */
const SUSTAIN_N_PREDICT = 128;

/** A neutral, non-grammar prompt. Deliberately generic: Gate 1 measures the decode engine's
 *  thermal behaviour, not task quality — that's Gate 2's job. */
const SUSTAIN_MESSAGES: RNLlamaOAICompatibleMessage[] = [
  {
    role: 'user',
    content:
      'Describe, in plain prose, how you would organise a week of household chores for a ' +
      'family of four. Keep going in detail until you are asked to stop.',
  },
];

// ---- LOGGING (same convention as the Q1 screens) ----

function appendAndLog(setLog: React.Dispatch<React.SetStateAction<string[]>>, line: string): void {
  setLog((prev) => [...prev, line]);
  console.log('[ModelBaseSpike]', line);
}

/** Monotonic per-session counter. scripts/q1-reassemble.js keys its output by tag, so two
 *  results sharing a tag silently overwrite each other — the Q1 screen dodged that with a
 *  distinct tag per stage. This spike runs the same gates against three models and may re-run
 *  any of them, so model+gate alone isn't unique enough; the sequence number makes it so. */
let runSeq = 0;

/** Tagged, chunked JSON — logcat truncates long lines and splits multi-line console.log calls
 *  into separate untagged lines, so this must stay compact (no pretty-print newlines). */
function logResultJson(gate: string, value: unknown): void {
  const tag = `MBRESULT:${activeModel.key}:g${gate}:r${runSeq++}`;
  const json = JSON.stringify(value);
  const CHUNK_SIZE = 3000;
  const totalChunks = Math.max(1, Math.ceil(json.length / CHUNK_SIZE));
  for (let i = 0; i < totalChunks; i++) {
    const chunk = json.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
    console.log(`[${tag} ${i + 1}/${totalChunks}] ${chunk}`);
  }
}

function buildManifest(): Record<string, unknown> {
  return {
    modelKey: activeModel.key,
    modelFilename: activeModel.filename,
    modelSha256: activeModel.sha256,
    llamaRnVersion: LLAMA_RN_VERSION,
    device: DEVICE_LABEL,
    runNote: RUN_NOTE,
    nCtx: N_CTX,
    nThreads: N_THREADS,
    nGpuLayers: N_GPU_LAYERS,
  };
}

export default function ModelBaseSpikeScreen() {
  const [log, setLog] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [modelKey, setModelKey] = useState<string>(MODELS[0].key);
  const contextRef = useRef<LlamaContext | null>(null);

  const appendLog = useCallback((line: string) => appendAndLog(setLog, line), []);

  // ---- Model release ----
  // Non-optional between models: leaving the previous context resident would make the next
  // model's peak-RAM reading meaningless, which is Gate 1's primary number.
  const releaseModel = useCallback(async () => {
    if (!contextRef.current) {
      appendLog('No context loaded — nothing to release.');
      return;
    }
    try {
      await contextRef.current.release();
      contextRef.current = null;
      appendLog('Context released. Re-check meminfo now to confirm the RAM came back.');
    } catch (err: any) {
      appendLog(`RELEASE FAILED: ${String(err)}`);
    }
  }, [appendLog]);

  const selectModel = useCallback(
    async (m: SpikeModel) => {
      if (contextRef.current) {
        appendLog(`Switching model — releasing ${activeModel.filename} first ...`);
        await releaseModel();
      }
      activeModel = m;
      setModelKey(m.key);
      appendLog(`Selected: ${m.label}  (${m.filename})`);
      appendLog(`  ${m.note}`);
      if (m.sha256.startsWith('<unset')) {
        appendLog('  WARNING: sha256 not filled in for this entry — the manifest will be weak.');
      }
    },
    [appendLog, releaseModel],
  );

  // ---- Gate 0a — header only ----
  // Isolates "arch unsupported / file corrupt" from "loads but misbehaves". This is the call
  // that answers the brief's Gate 0 question directly: if the arch string in the header is not
  // in this build's arch table, it fails HERE, with an "unknown model architecture" message.
  const runGate0a = useCallback(async () => {
    setRunning(true);
    const path = modelPath(activeModel);
    appendLog(`GATE 0a — reading model header from ${path} ...`);
    try {
      const info = await loadLlamaModelInfo(path);
      appendLog(`HEADER OK: ${JSON.stringify(info)}`);
      const arch = (info as Record<string, unknown>)?.['general.architecture'];
      appendLog(`  -> reported architecture: ${String(arch ?? '(not in header keys)')}`);
      logResultJson('0a', { ...buildManifest(), ok: true, info });
    } catch (err: any) {
      appendLog(`HEADER READ FAILED: ${String(err)}`);
      appendLog(`  message: ${err?.message}`);
      appendLog('  If this says "unknown model architecture", Gate 0 is a hard fail: the');
      appendLog('  pinned llama.rn build cannot see this arch. Stop and report.');
      logResultJson('0a', { ...buildManifest(), ok: false, error: String(err?.message ?? err) });
    } finally {
      setRunning(false);
    }
  }, [appendLog]);

  // ---- Gate 0b — full load (also produces Gate 1's load-time number) ----
  const runGate0b = useCallback(async () => {
    setRunning(true);
    const path = modelPath(activeModel);
    appendLog(`GATE 0b — loading ${path} (ctx=${N_CTX}, threads=${N_THREADS}, gpu=${N_GPU_LAYERS}) ...`);
    const start = Date.now();
    try {
      const ctx = await initLlama({
        model: path,
        use_mlock: true,
        n_ctx: N_CTX,
        n_threads: N_THREADS,
        n_gpu_layers: N_GPU_LAYERS,
      });
      contextRef.current = ctx;
      const loadMs = Date.now() - start;
      appendLog(`MODEL LOADED in ${loadMs}ms`);
      appendLog('  Take the post-load meminfo reading now, before running Gate 1.');
      logResultJson('0b', { ...buildManifest(), ok: true, loadMs });
    } catch (err: any) {
      appendLog(`LOAD FAILED after ${Date.now() - start}ms: ${String(err)}`);
      appendLog(`  message: ${err?.message}`);
      appendLog(`  code: ${err?.code}`);
      logResultJson('0b', { ...buildManifest(), ok: false, error: String(err?.message ?? err) });
    } finally {
      setRunning(false);
    }
  }, [appendLog]);

  // ---- Gate 1 — sustained decode ----
  // Runs back-to-back completions for SUSTAIN_MS and reports every iteration's tok/s, so the
  // shape of the curve is visible rather than just its endpoints. The brief's question is
  // specifically plateau-vs-collapse: the 4B TQ1_0 held ~5.2 tok/s flat, and a model that
  // starts faster but decays below that is a regression for us even if its burst number wins.
  const runGate1 = useCallback(
    async (durationMs: number, gateLabel: string) => {
    const ctx = contextRef.current;
    if (!ctx) {
      appendLog('Gate 1 needs a loaded context — run Gate 0b first.');
      return;
    }
    setRunning(true);
    appendLog(`GATE ${gateLabel} — sustained decode for ${(durationMs / 60000).toFixed(1)} min ...`);
    const started = Date.now();
    const samples: { i: number; atMs: number; tokPerSec: number; predictedN: number }[] = [];
    try {
      let i = 0;
      while (Date.now() - started < durationMs) {
        const result = await ctx.completion({
          messages: SUSTAIN_MESSAGES,
          n_predict: SUSTAIN_N_PREDICT,
          temperature: 0,
          top_k: 1,
        });
        const t = (result as { timings?: Record<string, number> }).timings ?? {};
        const sample = {
          i,
          atMs: Date.now() - started,
          tokPerSec: t.predicted_per_second ?? 0,
          predictedN: t.predicted_n ?? 0,
        };
        samples.push(sample);
        appendLog(
          `  [${(sample.atMs / 1000).toFixed(0)}s] iter ${i}: ` +
            `${sample.tokPerSec.toFixed(2)} tok/s (${sample.predictedN} tok)`,
        );
        i++;
      }

      // Burst = first iteration (coldest). Steady = mean of the final third, which is where the
      // thermal governor has settled if it is going to.
      const burst = samples[0]?.tokPerSec ?? 0;
      const tail = samples.slice(Math.floor(samples.length * (2 / 3)));
      const steady = tail.length
        ? tail.reduce((acc, s) => acc + s.tokPerSec, 0) / tail.length
        : 0;
      const retention = burst > 0 ? steady / burst : 0;

      // Has it actually floored? "Steady" is a mean, so it stays respectable while a curve is
      // still sliding — which is exactly what the 4.5-min runs could not distinguish. Compare
      // the last five samples against the five before them: near zero means a real plateau,
      // persistently negative means the floor is below whatever this window measured.
      const lastFive = samples.slice(-5);
      const prevFive = samples.slice(-10, -5);
      const mean = (xs: typeof samples) =>
        xs.length ? xs.reduce((acc, s) => acc + s.tokPerSec, 0) / xs.length : 0;
      const tailDrift = prevFive.length && mean(prevFive) > 0 ? mean(lastFive) / mean(prevFive) - 1 : 0;

      appendLog(
        `GATE ${gateLabel} DONE — ${samples.length} iterations over ${((Date.now() - started) / 1000).toFixed(0)}s`,
      );
      appendLog(`  burst (iter 0):      ${burst.toFixed(2)} tok/s`);
      appendLog(`  steady (final 1/3):  ${steady.toFixed(2)} tok/s`);
      appendLog(`  retention:           ${(retention * 100).toFixed(0)}% of burst`);
      appendLog(`  last5 vs prev5:      ${(tailDrift * 100).toFixed(1)}%  (~0 = floored)`);
      appendLog('  Take the end-of-loop meminfo reading now, while the context is still live.');
      logResultJson(gateLabel, {
        ...buildManifest(),
        ok: true,
        sustainMs: durationMs,
        nPredictPerIter: SUSTAIN_N_PREDICT,
        iterations: samples.length,
        burstTokPerSec: burst,
        steadyTokPerSec: steady,
        retention,
        tailDrift,
        samples,
      });
    } catch (err: any) {
      appendLog(`GATE ${gateLabel} FAILED at ${((Date.now() - started) / 1000).toFixed(0)}s: ${String(err)}`);
      appendLog(`  message: ${err?.message}`);
      logResultJson(gateLabel, {
        ...buildManifest(),
        ok: false,
        error: String(err?.message ?? err),
        samples,
      });
    } finally {
      setRunning(false);
    }
    },
    [appendLog],
  );

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.scrollContent}>
      <Text style={styles.title}>Model-base spike — S23 FE</Text>

      <Text style={styles.section}>Model</Text>
      {MODELS.map((m) => (
        <View key={m.key} style={styles.modelRow}>
          <Button
            title={`${modelKey === m.key ? '● ' : '○ '}${m.label}`}
            onPress={() => selectModel(m)}
            disabled={running}
          />
        </View>
      ))}

      <Text style={styles.section}>Gates</Text>
      <Button title="Gate 0a: header only (loadLlamaModelInfo)" onPress={runGate0a} disabled={running} />
      <View style={styles.spacer} />
      <Button title="Gate 0b: full load (initLlama)" onPress={runGate0b} disabled={running} />
      <View style={styles.spacer} />
      <Button
        title="Gate 1: sustained decode (4.5 min)"
        onPress={() => runGate1(SUSTAIN_MS, '1')}
        disabled={running}
      />
      <View style={styles.spacer} />
      <Button
        title="Gate 1L: long sustained (20 min)"
        onPress={() => runGate1(SUSTAIN_LONG_MS, '1L')}
        disabled={running}
      />
      <View style={styles.spacer} />
      <Button title="Release context" onPress={releaseModel} disabled={running} />

      <Text style={styles.section}>Log</Text>
      {log.map((line, idx) => (
        <Text key={idx} style={styles.logLine}>
          {line}
        </Text>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16 },
  scrollContent: { paddingBottom: 32 },
  title: { fontSize: 16, fontWeight: '600', marginBottom: 12 },
  section: { fontSize: 13, fontWeight: '700', marginTop: 16, marginBottom: 6 },
  modelRow: { marginBottom: 6 },
  spacer: { height: 8 },
  logLine: { fontFamily: 'monospace', fontSize: 12, marginBottom: 2 },
});
