# SAB-AUDIT-v47 — SeekerClaw Agent Self-Knowledge Audit

> **Date:** 2026-09-07
> **SAB Version:** v3
> **Scope:** Delta audit for the v2.3.0 release cycle (`65fc076a..bb737852`). Covers the gate-tripping surface only — the two `buildSystemBlocks()` edits (BAT-1306, BAT-1307), the 11 new WARN/ERROR log sites (BAT-1290), and the user-visible model-registry change (BAT-1315/1316 + GPT-6 Astra).
> **Method:** Diff-scoped read of the changed prompt lines, log-site enumeration against DIAGNOSTICS.md coverage, constants verification, and three-source check on the two tools whose descriptions changed.
> **Baseline:** SAB-AUDIT-v46.md (BAT-1186 Stage 1).
> **Gate status:** Run **late**. This should have run before merging PRs #452/#457/#458 per CLAUDE.md. It did not. The one gap it found is fixed here rather than in the originating PR, which breaks the same-PR rule — recorded honestly rather than papered over.

## Scores

Delta audit, so sections are scored **only over the changed surface**. A combined percentage against the full v46 item set would be misleading and is deliberately not given.

| Section | Scope audited | Pre-fix | Post-fix | Max |
|---------|---------------|---------|----------|-----|
| A: Knowledge & Doors | 2 changed prompt lines + model self-description + constants | 12 | 12 | 12 |
| B: Diagnostics | 11 new WARN/ERROR sites (BAT-1290) | 0 | 33 | 33 |
| C: Tool Consistency | `android_sms`, `android_call` (descriptions changed) | 6 | 6 | 6 |
| D: Behavioral Probes | **not run** — see Remaining Gaps | — | — | — |
| **Combined (audited surface)** | | **18 / 51 (35%)** | **51 / 51 (100%)** | 51 |

The pre-fix figure is dominated by one gap: an entire new subsystem's error vocabulary shipped with zero diagnosis path.

## Section A — Knowledge & Doors

**Constants: all correct.**

| Constant | Expected | Found |
|---|---|---|
| `MAX_HISTORY` | in `ai.js` | `ai.js:305 = 35` ✅ |
| `SHELL_ALLOWLIST` | `config.js` | `config.js:913` ✅ |
| `ALLOWED_CMDS` | alias in `tools/system.js` | `tools/system.js:139` ✅ |
| `SOLANA_WRITE_TOOLS` | `confirmation/policy.js` | `policy.js:62` ✅ |
| `MAX_TOOL_USES` | must NOT exist | 0 occurrences ✅ |

**BAT-1306 — `jupiter_token_security` line.** Rewritten from `ALWAYS check unknown tokens` to a condition (*"before a swap or transfer involving a mint not already verified this session"*). Still accurate about the capability; the change narrows *when*, not *what*. ✅

**BAT-1307 — paysh-catalog block.** ~1,293 characters of provenance removed. The two load-bearing rules survive, verified present: the opt-in keyword list, and **"NEVER call `agent_pay` autonomously"**. The honesty affordance also survives — the block still points at `unsupported.json` and its `reasons{}` registry for the *"I know about X but cannot use it because Y"* answer. So the agent can still decline accurately; it simply no longer recites endpoint counts it never acted on. ✅

**Model self-description — no staleness.** This was the item most at risk from BAT-1315/1316, and it is clean by design: **the prompt hardcodes no model list.** The only model reference is `Provider: ${PROVIDER}, Model: ${activeModel}`, resolved per turn, plus an explicit note that the active model can change mid-conversation (BAT-1083). Adding Opus 5 / Fable 5.1 / Grok 4.6 / GPT-6 Astra and dropping Opus 4.7, 4.6 and Grok 4.3 therefore introduced **zero** prompt drift, and the agent cannot claim access to a dropped model because it never enumerated models from the prompt. ✅

## Section B — Diagnostics

**Gap found, and it is the whole of the pre-fix deficit.**

BAT-1290 added **11 WARN/ERROR sites** in `reasoning-recovery.js` (0 DEBUG). None of its outcome vocabulary appeared in `DIAGNOSTICS.md` or the prompt:

| String | DIAGNOSTICS (pre-fix) | Prompt |
|---|---|---|
| `parse-failed` | 0 | 0 |
| `no-cut-point` | 0 | 0 |
| `quarantined resumed` | 0 | 0 |
| `quarantine FAILED` | 0 | 0 |
| `invalid checkpointKind` | 0 | 0 |
| `no tasksDir supplied` | 0 | 0 |

The pre-existing reasoning entries (`DIAGNOSTICS.md:495–501`) describe the *Custom + DeepSeek V4* 400 loop and mention "the adaptive 3-step quarantine", but predate BAT-1290 and carry none of the new reason strings. A user reading `[ReasoningRecovery] Step 3 quarantined resumed checkpoint (parse-failed)` had nothing to look up.

**Fixed** — new section *"Reasoning-400 Checkpoint Quarantine — `[ReasoningRecovery]` Log Lines (BAT-1290)"*, with a reason-string table separating "mechanism working, do nothing" from "code defect, report it", the `tasks/` and `recovery/` inspection commands, and the historic note that builds ≤ v2.2.0 wrote the quarantine to a directory nothing created, so the on-disk repair never ran at all.

All 11 gated sites now resolve to an entry.

## Section C — Tool Consistency

Only the two tools whose descriptions changed were checked (delta scope).

- **`android_sms` / `android_call`** — descriptions changed from `ALWAYS confirm with user before sending/calling` to `Confirmation-gated: the runtime asks the user before this executes, so do not ask separately`. This now matches reality: both are in `V1_STATIC_CONFIRM` and `ai.js` runs the gate *before* dispatch, so the model never could have gated them itself. DIAGNOSTICS retains its `SEND_SMS` permission-error coverage. ✅ ✅

**Device-confirmed**, which is stronger than a source check: a live SMS produced exactly one gate cycle — `Tool use: android_sms` → one `[Confirm] Awaiting confirmation` → `APPROVED` → `Executing tool`. No model-authored second prompt.

## Remaining Gaps

1. **Section D (behavioral probes) not run.** Five end-to-end probes are part of a full audit; this delta covered the gated surface only. Not a blocker for the RC — no probe target changed this cycle — but v48 should be a full-suite audit rather than another delta.
2. **Section C rotated-5 not run**, same reason.
3. **The gate fired late.** The same-PR rule was broken: the DIAGNOSTICS fix lands in the release commit rather than in PR #452 where the log sites were added. The process failure is the finding, not the content.

## Code Issues Found

None. The one gap was documentation, not behaviour.

## Verdict

**Does not block v2.3.0-rc1.** The single gap is closed, all 11 new error paths now have a diagnosis path, and the model-registry change — the largest user-visible shift this cycle — turned out to need no prompt work at all because the prompt never hardcoded a model list.
