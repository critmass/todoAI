// AUTO-GENERATED — do not hand-edit. Byte-identical copies of task 5's checked-in .gbnf
// grammar files, embedded as string constants because Metro cannot import a raw .gbnf into the
// RN bundle (the provider, task 6, needs the grammar text at runtime). Regenerate, never patch;
// __tests__/grammarText.test.ts guards each constant against its source file.
//
// These are TEMPLATES where noted (D7): {{...}} slots must be substituted via
// src/llm/grammar/buildGrammar.ts before use — they are not valid GBNF as-is.

export const TASK_EXTRACTION_V1_GBNF = `# task_extraction.v1.gbnf
# Generated from task_extraction.v1.json (schema version: v1), then hand-tightened per D3
# (compact JSON, fixed key order = generation order, closed enums, bounded everything, no
# free-text reasoning field). This is a TEMPLATE (D7): {{context_tags_known}} must be
# substituted via src/llm/grammar/buildGrammar.ts before use - it is not valid GBNF as-is.
#
# {m,n} support on llama.rn 0.12.5's bundled llama.cpp is UNVERIFIED (no device this session -
# see eval Q1 in the strategy doc). If Q1 shows it's unsupported, every \`{m,n}\` occurrence
# below can be mechanically expanded via src/llm/grammar/boundedRepetition.ts - a config flip,
# not a rewrite of this file.
#
# RULE-NAME CONSTRAINT (Q1c, docs/eval/Q1c_findings_report.md): no rule name below may contain
# \`_\` - llama.cpp's GBNF parser on this build lexes rule names with an \`is_word_char\` predicate
# that excludes \`_\`, so an underscore silently truncates the identifier and the parser then
# fails on the malformed remainder. JSON keys and string literal values (e.g. the
# "estimated_duration_minutes" key) are UNAFFECTED and keep their underscores - only bare rule
# identifiers are renamed to camelCase. (Q1b's earlier "rule name must match its own JSON key"
# theory is retracted - it was a confound; see the Q1c report.)

root ::= "{\\"title\\":" title ",\\"description\\":" description ",\\"estimated_duration_minutes\\":" estimatedDurationMinutes ",\\"duration_from_user\\":" durationFromUser ",\\"due\\":" due ",\\"context_tags\\":" contextTags ",\\"tool_requirements\\":" toolRequirements ",\\"energy\\":" energy ",\\"importance_user\\":" importanceUser ",\\"recurrence\\":" recurrence "}"

# --- title, description ---
title ::= "\\"" jchar{1,80} "\\""
description ::= "null" | "\\"" jchar{1,200} "\\""

# --- duration ---
# Digit-count bounded (up to 4 digits), not exact-range: GBNF can't express ">1440 forbidden"
# without enumeration. The zod validator enforces the exact [1,1440] range (D10).
estimatedDurationMinutes ::= [1-9] [0-9]{0,3}
durationFromUser ::= "true" | "false"

# --- due (DueSpec union, D5 - model transcribes, code resolves via due/dueSpec.ts) ---
due ::= "null" | dueOnDate | dueInDays | dueWeekday
# \`date\` (was \`date_str\`) - Q1c (docs/eval/Q1c_findings_report.md) found the real trigger was
# the underscore in \`date_str\`'s own name, not a key-mismatch as Q1b concluded. Kept as \`date\`
# here since it already satisfies the no-underscore rule and is a clean, principled name.
# Digit/dash structure is no longer grammar-enforced - validator.ts's date regex (D10) is the
# sole enforcer of the real YYYY-MM-DD shape now.
dueOnDate ::= "{\\"kind\\":\\"on_date\\",\\"date\\":" date "}"
date ::= "\\"" jchar{1,10} "\\""
dueInDays ::= "{\\"kind\\":\\"in_days\\",\\"days\\":" daysInt "}"
daysInt ::= [1-9] [0-9]{0,2}
dueWeekday ::= "{\\"kind\\":\\"weekday\\",\\"day\\":" weekday ",\\"which\\":" which "}"
which ::= "\\"this\\"" | "\\"next\\""

# --- context_tags (D7 dynamic-vocabulary slot: known tags + one bounded new-tag escape) ---
contextTags ::= "[]" | "[" tag ("," tag){0,4} "]"
tag ::= tagKnown | newTag
tagKnown ::= "\\"" {{context_tags_known}} "\\""
newTag ::= "\\"" jchar{1,20} "\\""

# --- tool_requirements (static, not a dynamic slot) ---
toolRequirements ::= "[]" | "[" tool ("," tool){0,4} "]"
tool ::= "\\"" jchar{1,20} "\\""

# --- energy, importance_user (D4: user-scale only, code projects through scales.ts) ---
energy ::= "null" | "\\"low\\"" | "\\"med\\"" | "\\"high\\""
importanceUser ::= "null" | importanceValue
importanceValue ::= [1-9] | "10"

# --- recurrence (RecurrenceSpec union, D6) ---
# null (true one-off) and {"type":"unscheduled"} are separate branches with opposite
# completion semantics and must never collapse into one another (constraint #5, data-layer
# brief). Each variant branches after its "type" discriminator and carries only that
# variant's keys (D3.2).
recurrence ::= "null" | recScheduledQuota | recQuota | recScheduled | recUnscheduled | recCount
recScheduledQuota ::= "{\\"type\\":\\"scheduled_quota\\",\\"quota\\":" quotaInt ",\\"period\\":" period ",\\"days\\":" weekdayArray "}"
recQuota ::= "{\\"type\\":\\"quota\\",\\"quota\\":" quotaInt ",\\"period\\":" period "}"
recScheduled ::= "{\\"type\\":\\"scheduled\\",\\"days\\":" weekdayArray "}"
recUnscheduled ::= "{\\"type\\":\\"unscheduled\\"}"
recCount ::= "{\\"type\\":\\"count\\",\\"target\\":" targetInt "}"
quotaInt ::= [1-9] [0-9]{0,2}
targetInt ::= [1-9] [0-9]{0,2}
period ::= "\\"day\\"" | "\\"week\\"" | "\\"month\\""
weekdayArray ::= "[" weekday ("," weekday){0,6} "]"
weekday ::= "\\"monday\\"" | "\\"tuesday\\"" | "\\"wednesday\\"" | "\\"thursday\\"" | "\\"friday\\"" | "\\"saturday\\"" | "\\"sunday\\""

# --- shared primitives ---
jchar ::= [^"\\\\\\x00-\\x1F] | "\\\\" (["\\\\/bfnrt] | "u" [0-9a-fA-F]{4})
`;

export const TASK_BREAKDOWN_V1_GBNF = `# task_breakdown.v1.gbnf
# Generated from task_breakdown.v1.json (schema version: v1), then hand-tightened per D3.
# This is a TEMPLATE (D7): {{parent_task_id}} must be substituted via
# src/llm/grammar/buildGrammar.ts before use (a single-value slot - the one task being broken
# down, known exactly at call time; not an alternation among candidates).
#
# {m,n} support is unverified on-device (eval Q1) - see task_extraction.v1.gbnf's header for
# the fallback plan (src/llm/grammar/boundedRepetition.ts).
#
# RULE-NAME CONSTRAINT (Q1c, docs/eval/Q1c_findings_report.md): no rule name below may contain
# \`_\` - see task_extraction.v1.gbnf's header for the full explanation.

root ::= "{\\"parent_task_id\\":" {{parent_task_id}} ",\\"ordered\\":" ordered ",\\"subtasks\\":" subtasks "}"

ordered ::= "true" | "false"

# 2-8 subtasks: one mandatory + 1-7 more, each comma-prefixed.
subtasks ::= "[" subtask ("," subtask){1,7} "]"
subtask ::= "{\\"title\\":" title ",\\"estimated_duration_minutes\\":" estimatedDurationMinutes ",\\"duration_from_user\\":" durationFromUser "}"

title ::= "\\"" jchar{1,80} "\\""
# Digit-count bounded, not exact-range (see task_extraction.v1.gbnf's note) - the zod
# validator enforces the exact [1,1440] range.
estimatedDurationMinutes ::= [1-9] [0-9]{0,3}
durationFromUser ::= "true" | "false"

# --- shared primitives ---
jchar ::= [^"\\\\\\x00-\\x1F] | "\\\\" (["\\\\/bfnrt] | "u" [0-9a-fA-F]{4})
`;

export const COACHING_RESOLUTION_V1_GBNF = `# coaching_resolution.v1.gbnf
# Generated from coaching_resolution.v1.json (schema version: v1), then hand-tightened per D3.
# A union grammar, not native tool-calling (D8). This is a TEMPLATE (D7): {{task_id}},
# {{depends_on_task_id}}, and {{context_tags_known}} must be substituted via
# src/llm/grammar/buildGrammar.ts before use. task_id/depends_on_task_id are NEVER a bare
# [0-9]+ rule - a 4B will eventually fabricate an id if given one; the app injects the exact
# 1-5 candidate ids in play as a literal alternation instead.
#
# {m,n} support is unverified on-device (eval Q1) - see task_extraction.v1.gbnf's header for
# the fallback plan (src/llm/grammar/boundedRepetition.ts).
#
# RULE-NAME CONSTRAINT (Q1c, docs/eval/Q1c_findings_report.md): no rule name below may contain
# \`_\` - llama.cpp's GBNF parser on this build lexes rule names with an \`is_word_char\` predicate
# that excludes \`_\`, so an underscore silently truncates the identifier and the parser then
# fails on the malformed remainder. JSON keys and string literal values (e.g. the
# "duration_minutes" key, the "modify_task" action value) are UNAFFECTED - only bare rule
# identifiers are renamed to camelCase. (Q1b's earlier "rule name must match its own JSON key"
# theory is retracted - it was a confound; see the Q1c report.)

root ::= modifyTask | breakDownTask | eliminateTask | deferTask | addDependency | addMissingTask | noChange

# --- modify_task ---
modifyTask ::= "{\\"action\\":\\"modify_task\\",\\"task_id\\":" taskId ",\\"changes\\":" changes "}"
changes ::= "{\\"duration_minutes\\":" changesDuration ",\\"context_tags\\":" changesContextTags ",\\"energy\\":" changesEnergy ",\\"approach_notes\\":" changesNotes "}"
changesDuration ::= "null" | durationInt
durationInt ::= [1-9] [0-9]{0,3}
changesContextTags ::= "null" | contextTags
contextTags ::= "[]" | "[" tag ("," tag){0,4} "]"
tag ::= tagKnown | newTag
tagKnown ::= "\\"" {{context_tags_known}} "\\""
newTag ::= "\\"" jchar{1,20} "\\""
changesEnergy ::= "null" | "\\"low\\"" | "\\"med\\"" | "\\"high\\""
changesNotes ::= "null" | "\\"" jchar{1,200} "\\""

# --- break_down_task (stub: id only, D8 - triggers task_breakdown.v1 as its own staged call) ---
breakDownTask ::= "{\\"action\\":\\"break_down_task\\",\\"task_id\\":" taskId "}"

# --- eliminate_task ---
eliminateTask ::= "{\\"action\\":\\"eliminate_task\\",\\"task_id\\":" taskId ",\\"reason\\":" reason120 "}"
reason120 ::= "\\"" jchar{1,120} "\\""

# --- defer_task ---
deferTask ::= "{\\"action\\":\\"defer_task\\",\\"task_id\\":" taskId ",\\"until\\":" until "}"
until ::= "null" | untilOnDate | untilInDays | untilWeekday | untilCondition
# \`date\` (was \`date_str\`) - Q1c (docs/eval/Q1c_findings_report.md) found the real trigger was
# the underscore in \`date_str\`'s own name, not a key-mismatch as Q1b concluded. Kept as \`date\`
# here since it already satisfies the no-underscore rule and is a clean, principled name.
# Digit/dash structure is no longer grammar-enforced - validator.ts's date regex (D10) is the
# sole enforcer now.
untilOnDate ::= "{\\"kind\\":\\"on_date\\",\\"date\\":" date "}"
date ::= "\\"" jchar{1,10} "\\""
untilInDays ::= "{\\"kind\\":\\"in_days\\",\\"days\\":" daysInt "}"
daysInt ::= [1-9] [0-9]{0,2}
untilWeekday ::= "{\\"kind\\":\\"weekday\\",\\"day\\":" weekday ",\\"which\\":" which "}"
weekday ::= "\\"monday\\"" | "\\"tuesday\\"" | "\\"wednesday\\"" | "\\"thursday\\"" | "\\"friday\\"" | "\\"saturday\\"" | "\\"sunday\\""
which ::= "\\"this\\"" | "\\"next\\""
untilCondition ::= "{\\"condition\\":" condition120 "}"
condition120 ::= "\\"" jchar{1,120} "\\""

# --- add_dependency ---
addDependency ::= "{\\"action\\":\\"add_dependency\\",\\"task_id\\":" taskId ",\\"depends_on_task_id\\":" dependsOnTaskId "}"
dependsOnTaskId ::= {{depends_on_task_id}}

# --- add_missing_task (stub: title only, D8 - triggers task_extraction.v1 as its own staged call) ---
addMissingTask ::= "{\\"action\\":\\"add_missing_task\\",\\"title\\":" title "}"
title ::= "\\"" jchar{1,80} "\\""

# --- no_change (first-class action, D8 - without it the grammar corners the model into inventing an intervention) ---
noChange ::= "{\\"action\\":\\"no_change\\",\\"reason\\":" reason120 "}"

# --- shared: dynamic task_id slot (D7 - never a bare [0-9]+ rule) ---
taskId ::= {{task_id}}

# --- shared primitives ---
jchar ::= [^"\\\\\\x00-\\x1F] | "\\\\" (["\\\\/bfnrt] | "u" [0-9a-fA-F]{4})
`;

export const SUMMARY_V1_GBNF = `# summary.v1.gbnf
# Generated from summary.v1.json (schema version: v1), then hand-tightened per D3. Fully
# static - no dynamic slots (D7): task ids and ratings are attached by code from flow state,
# never emitted by the model.
#
# {m,n} support is unverified on-device (eval Q1) - see task_extraction.v1.gbnf's header for
# the fallback plan (src/llm/grammar/boundedRepetition.ts).
#
# RULE-NAME CONSTRAINT (Q1c, docs/eval/Q1c_findings_report.md): no rule name below may contain
# \`_\` - see task_extraction.v1.gbnf's header for the full explanation.

root ::= "{\\"summary_schema_version\\":\\"1\\",\\"kind\\":" kind ",\\"key_points\\":" keyPoints ",\\"disposition\\":" disposition ",\\"energy_note\\":" energyNote "}"

kind ::= "\\"work_session\\"" | "\\"coaching_conversation\\"" | "\\"task_input\\"" | "\\"energy_checkin\\"" | "\\"pattern_recognition\\"" | "\\"task_completion\\"" | "\\"task_skip\\""

# 1-3 key points: one mandatory + 0-2 more, each comma-prefixed.
keyPoints ::= "[" keyPoint ("," keyPoint){0,2} "]"
keyPoint ::= "\\"" jchar{1,120} "\\""

disposition ::= "null" | "\\"" jchar{1,120} "\\""
energyNote ::= "null" | "\\"" jchar{1,80} "\\""

# --- shared primitives ---
jchar ::= [^"\\\\\\x00-\\x1F] | "\\\\" (["\\\\/bfnrt] | "u" [0-9a-fA-F]{4})
`;
