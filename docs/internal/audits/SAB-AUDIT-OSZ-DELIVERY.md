# SAB delta audit — osZ delivery/runtime settings

Scope: `fix/osz-delivery-runtime-settings`, pre-merge and pre-APK validation.
This is a changed-surface audit, not a claim that the full SAB v3/real-provider
behavioral benchmark was run. Baseline: SAB-AUDIT-v47.

## Gaps found and fixed in this branch

1. Full prompt knew nothing about durable responses or `/outbox`. Added saved-answer,
   uncertain-ACK, explicit retrieval, duplicate-risk and STOP semantics.
2. Hardened prompt compaction would have removed those additions. Updated its Error
   Recovery and Config Awareness replacements; executable delta self-awareness probe
   checks the resulting compact prompt, not just the pre-compaction source.
3. Blanket immediate-key-refresh claim was false. Prompt, compact prompt, diagnostics
   and web_search description now distinguish live conversational search-key refresh
   from Android-managed keys, which require a controlled restart and keep precedence.
4. New `[RuntimeSettings]`, `[Delivery]`, failed-publication and unconfirmed transport
   vocabulary now has a DIAGNOSTICS entry and recovery door, without suggesting a
   memory reset, blind retry or an IPv6 diagnosis.

## PR #17 review follow-up

Review 5677022913 exposed eight real gaps after the first green suites, including
an untested string/array command boundary and stale full-formatting/Channel UI
restart instructions. They are not dismissed as already-tested behavior. See
`docs/internal/OSZ-PR17-REVIEW-FIXES.md` for each finding, repair and regression.
Full and compact prompts now explain bot-scoped recovery, ACK-only text cleanup
and 24-hour deduplication (pending text never expires); key-refresh knowledge
explicitly covers valid revocation without erasing Android-owned credentials.
Both real full-formatting branches are executed by tests, not merely checked for
a new global sentence that can coexist with stale opposite instructions.

## Executed behavioral/code probes

The CI-gated `osz-delivery-runtime.test.js` drives the actual sender, outbox, handler,
settings reader, Tavily routing and HTTP transport with synthetic dependencies.
Coverage includes lost ACK, crash during ATTEMPTING, partial chunks, repeated/concurrent
calls, STOP marker, owner/chat isolation, disk failure, 12/60 retention and live Rich.
The compact-prompt/diagnostics probe checks the self-awareness doors and new log sites.
The registered `/outbox` handler is also checked by telegram-commands.test.js.

Pass counts and exact tested commit are taken from the CI run, not inferred here.
No user memory, keys or real Telegram/Tavily requests are used by these probes.

## Deliberate limitations conveyed to the agent

- No exactly-once promise after an ambiguous new-message POST.
- `/outbox show` is explicit retrieval, not automatic resend or tool re-execution.
- Only tracked interactive replies are covered; system notices/uploads/background
  sends without a delivery key are outside this contract.
- Pending records are not automatically replayed, cleared, or rotated away.
- Real model-language SAB probes and phone/mobile-network E2E are not run here;
  no fabricated 100% full-SAB score or production-delivery guarantee is claimed.
