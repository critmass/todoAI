# NUL byte in `score.ts` — the scoring composition was invisible to code review

**Status:** Done. **Scope:** one line of `src/scoring/score.ts`, plus its doc comment.
**Not a task** — a defect fix carved out of task 36's findings report (§6, "Incidental, pre-existing"), which flagged it but deliberately left it alone pending the question below.

> **Reconciling this with task 36's report.** That report still reads "Incidental, pre-existing, **not fixed**", and it is *left that way on purpose*: it is a point-in-time record of what was true when task 36 ran, and back-editing it would erase the history of how this was found and deferred. **This brief is the forward record — where the report says "not fixed", read on to here.** Same convention applies to anything downstream of this document: add the resolution here, don't rewrite the report that raised it.

---

## 1. What was wrong

`contextGroupKey` returned its no-tags sentinel as a **raw 0x00 byte** followed by `flexible`:

```ts
if (task.contextTags.length === 0) return '<NUL>flexible';   // raw byte, renders as a leading space
```

Exactly one NUL in the file, at byte offset ~6413 — well inside the first 8000 bytes git samples. So **git classified `score.ts` as binary**, and every diff of it rendered as `Bin 8860 -> 9177 bytes` instead of lines.

The cost was not runtime, it was review. `score.ts` is the scoring composition — `scoreTask`, `scoreTasks`, `rankWithContextNovelty`, the weighted shuffle — one of the most-reviewed files in the project, and it silently never appeared in a reviewable diff. **It had been binary since `8903e74`, the file's own first commit** (`Bin 0 -> 6808 bytes`), so a readable diff of this file had never existed at any point in its history. That is almost certainly why it went unnoticed for so long: there was no "before" state anyone could have compared against.

## 2. The question that had to be answered first

The findings report declined to touch it because the sentinel's whole point *may* have been "a byte no real context tag can contain." Changing a deliberate unforgeable sentinel to a plain string would be a real regression, so intent had to be settled before the fix.

**Verdict: the raw byte was accidental.** Four independent signals:

1. **The doc comment describes a plain string** — "tasks with no tags share the `'flexible'` group." No mention of a sentinel byte or of collision-proofing. This codebase documents load-bearing invariants at length (the 8-line POOL CONTRACT block directly below, on `rankWithContextNovelty`, exists for a far subtler property). A deliberately unforgeable key would have been explained.
2. **The sibling separator has identical exposure and no protection.** The very next line is `[...task.contextTags].sort().join('|')` — tags `['a|b']` and `['a','b']` both produce `"a|b"`. An author reasoning about key collisions would not guard the empty case and ignore the join.
3. **A raw NUL is not typeable.** A deliberate sentinel would have been written `'\x00flexible'` in source. A raw byte is a paste or generation artifact.
4. **The file was binary from birth**, so the author never once saw this line in a diff.

## 3. But the property it accidentally provided is real — so it was kept

A collision is *possible*, not merely theoretical. The extraction grammar's tag rule is:

```
tag     ::= tagKnown | newTag
newTag  ::= "\"" jchar{1,20} "\""
```

`newTag` is 1–20 arbitrary JSON characters, and the seed vocabulary is ordinary words (`home`, `office`, `phone`, `computer`). Nothing stops the extractor minting a tag literally named `flexible` — at which point a plain `'flexible'` sentinel would merge the no-tags group into the tagged-`flexible` group, quietly corrupting both the novelty shuffle's grouping and the planner's context-switch break count. The DB agrees there is no guard: `context_tags TEXT CHECK (json_valid(context_tags))` constrains shape, not characters.

So the fix keeps the NUL and changes only **how it is spelled**:

```ts
if (task.contextTags.length === 0) return '\x00flexible';   // escape, not a raw byte
```

This was the strictly dominant option. The runtime key is byte-identical, so no behavior can regress; the source file is text again; and the sentinel now *reads* as intentional instead of looking like a stray space. The alternative (`'__flexible'`) would have changed the runtime value for no gain and is itself forgeable — `__flexible` is a legal 10-character `newTag`.

The doc comment was rewritten to state the invariant and, explicitly, to say **keep it written as the escape** — otherwise the next person to "clean up" the odd-looking literal reintroduces the binary-file problem.

## 4. Why changing the value was safe to reason about

`contextGroupKey` has exactly two call sites, both in-memory:

- `src/scoring/score.ts:179` — `Map` key in `rankWithContextNovelty`'s grouping.
- `src/planning/planner.ts:333, 348` — `Set` for counting distinct groups (context-switch break cost), and `Map` for the arrangement pass.

It is **never persisted, serialized, logged, or displayed**, and no test asserts on its literal value. The key is only ever compared with itself — which is what made the escape swap a zero-risk change rather than a data-format change.

## 5. Verification

| Check | Result |
| --- | --- |
| `npx jest src/scoring src/planning` | 7 suites, **91 tests, all pass** |
| `npx tsc --noEmit` | **exit 0**, clean |
| NUL byte count in `score.ts` | **1 → 0** |
| Runtime key unchanged | temp test asserted `key.charCodeAt(0) === 0` and `key === String.fromCharCode(0) + 'flexible'` — passed, then removed |
| Collision-proofing intact | same test asserted the no-tags key `!==` the key for a task tagged `['flexible']` — passed |
| Nothing else in the file changed | old blob vs new, both with the sentinel normalized: **only line 117 differs**, the other 191 lines byte-identical |
| `score.ts` is text to git | `git diff --no-index /dev/null src/scoring/score.ts` → **192 insertions**, not `Bin` |

**One expected wrinkle:** `git diff` *of this change* still reports `Bin 9177 -> 9180 bytes`, because git marks a diff binary if **either** side is, and the HEAD side still contains the NUL. That resolves once the fix is committed — this is the last unreadable diff `score.ts` will produce.

## 6. Follow-on worth considering (not done here)

The `join('|')` ambiguity from §2.2 is still live: a tag containing `|` collides with a two-tag set. It is lower-probability than the `flexible` case was and it is a genuine behavior change to fix (the key format changes), so it was left out of a defect fix scoped to the NUL byte. If it is ever worth closing, the cheap version is joining on the same `\x00` the empty case already relies on.
