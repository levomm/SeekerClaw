# osZ: Telegram delivery and effective settings — diagnostic findings

> Historical pre-fix baseline. Repairs are being implemented on
> `fix/osz-delivery-runtime-settings`. The old characterization entry point now
> runs the CI-gated repaired-behavior suite `osz-delivery-runtime.test.js`.

## Scope and evidence

Diagnostic-only work on `fix/osz-bridge-recovery`, based on commit
`490846150b2a931b07df12512d1ab37659d6d038`. No new APK build, installation,
service restart, configuration write, user-memory/identity edit, or live Telegram/Tavily
API send/search was performed in this investigation.

Read-only inspection of the phone's installed PUBLIC APK confirms Hardened 2
2.3.4 / code 28 at that commit. Its packaged telegram.js, ai.js, main.js,
config.js, tools/web.js and web.js match the checked-out sources byte-for-byte.
This establishes packaged-code relevance, not the active process's private runtime
settings. ADB has no connected device; private app files have not been read.

User reports IPv4 and IPv6 HTTPS requests to Telegram return HTTP/2 302 over
mobile data. Do NOT diagnose broken IPv6 from these timeout symptoms. Those
results show both tested routes work; they do not establish the outcome of an
individual Bot API POST, its transport phase, or its server-side acceptance. The
embedded client uses Node https.request (HTTP/1.1), not the HTTP/2 client used in
the reported check; this is a difference in test coverage, NOT proof of a network
or IPv6 fault.

## 1. Why a Rich response can disappear on ETIMEDOUT

- `telegram.js:telegram()` calls `http.js:httpRequest`; socket errors/timeouts reject.
- `classifyTelegramOutcome` classifies EVERY thrown transport error as `uncertain`.
- `richTrySend` logs `possibly delivered; no classic fallback` and returns
  `{delivered:true}` WITHOUT a Telegram message ID. This is a local instruction to
  suppress fallback, not a confirmed remote delivery.
- `sendMessage` resolves `undefined`. `message-handler.js:deliverAgentText` ignores
  the return value, returns true, and even records interim text in its per-turn
  dedup Set. The final handler can mark the reaction done and report message stats
  without a confirmed message ID.
- `ai.js` clears the active task and, for progressed tool turns, its checkpoints
  BEFORE returning the final answer for Telegram delivery. The answer is appended
  to in-memory conversation, but that is not a durable delivery outbox.
- `sentMessageCache` is an in-memory cache populated only for known message IDs;
  it is not a pending-delivery queue. Disabling Rich leaves the equivalent classic
  timeout/no-ACK problem intact.

Thus the implementation suppresses possible duplicates by accepting possible loss.
The 27-case offline characterization suite reproduces this; passing these tests
means the current behavior is understood, NOT that the loss bug is fixed.

Additional observed behavior: Rich `429` and `503` responses immediately fall
through to a classic send. Classic transient handling does not itself do that.
Rate-limit-aware backoff and an explicit rejection policy are missing here.

## 2. Safe preservation and retry design (not implemented)

Separate model completion from transport completion. Save the exact sanitized
answer and chunk boundaries durably BEFORE the first POST, with a stable local
`delivery_id`, task/turn association, chat/reply target, timestamps and per-chunk
state. Use a new app-private outbox, not MEMORY/SOUL/IDENTITY or the existing memory
DB as an improvised queue. Apply atomic writes/fsync as appropriate, preserve
unknown records on errors, and do not discard completed output before durable
outbox acceptance. Never log answer text, keys or raw chat identifiers.

Recommended states: READY -> ATTEMPTING -> ACKNOWLEDGED / RETRYABLE_REJECTED /
UNCERTAIN / PERMANENT_REJECTED. An ATTEMPTING record found after a crash must become
UNCERTAIN rather than blindly resending. Record confirmed Telegram message IDs
atomically. Serialize one delivery worker per record/chat and track acknowledgments
per chunk; never resend the confirmed prefix of a partially delivered answer.
Honor STOP, bounded retries, backoff/jitter, and server `retry_after`. A local
hash/delivery ID prevents duplicate LOCAL jobs, not duplicate server messages.

**There is no honest automatic exactly-once guarantee for an ambiguous new-message
POST in the current implementation.** Neither Telegram message IDs nor a server-side
idempotency contract are available to this path after a lost acknowledgment. An
immediate Rich -> classic retry can create a duplicate if Rich actually landed.

For UNCERTAIN: retain the answer and its uncertainty, do not auto-create another
visible message, and offer explicit user-controlled recovery, explaining duplicate
risk. For a KNOWN message ID, retrying an edit of that same message is preferable
to creating a new one; handle `message is not modified` as convergence. A placeholder
creation can itself time out, so it is not a magical exactly-once solution. A new
safe retry path requires tests for accepted-but-ACK-lost, not-accepted, process death,
partial chunks, rate limits, edits, concurrent workers and STOP.

## 3. maxSteps 35 vs Settings 12

`ai.js` computes configuredMaxSteps once per chat() call:

1. workspace/agent_settings.json `maxStepsPerTurn`, valid range 10..100;
2. startup config.json snapshot's `maxStepsPerTurn`;
3. literal 35.

12 is valid; tests prove a valid overlay 12 overrides a startup 35. This value is
not MAX_HISTORY (also ~35), the tool search limit or a reasoning-token budget.
Changing Settings midway through an already-running turn does not change that
turn's captured limit. Old trace lines or a different running app/bot must also be
ruled out using turn timestamps/package identity.

Confirmed source-level failure path: ConfigManager.writeAgentSettingsJson uses a
non-atomic `File.writeText`. Its errors are logged and swallowed; saveConfig can
still succeed after prefs are committed, so the UI can show 12 while the overlay
remains old/unreadable. A concurrent reader can see a truncated file. Node silently
catches JSON/read errors and falls back to a startup 35. The tests reproduce
absent, empty, partial and unreadable overlay fallbacks. This is a demonstrated
mechanism, NOT yet the proven phone-side event.

A corrective patch should publish atomically, propagate publication failure, retain
the last valid live values, and log effective limit + source once per turn without
secrets. Do not silently increase a user-selected 12 to 35 after a transient read
error. No such production change was made during this diagnosis.

## 4. Heartbeat 60 and Tavily: what is actually verified

### Heartbeat

main.js reads `heartbeatIntervalMinutes` from workspace/agent_settings.json at each
one-minute scheduler tick. Valid range is 5..120; 60 => 3,600,000 ms. Fallback is the
startup config value, then 30 minutes. Fake-clock tests execute the actual scheduler:
no probe at minute 59, one at minute 60, no additional probe at minute 61.

The minute tick is NOT a minute heartbeat. Startup waits the full interval; silent
HEARTBEAT_OK produces no user message. Usage cooldown, quiescence, missing owner and
an already-running probe may skip work. `lastHeartbeatAt` advances before the probe,
including skipped probes. The startup `Interval set to ...` line is not re-logged
on every live Settings change; an old startup line alone cannot prove current state.
Actual live 60-minute adoption is NOT confirmed without runtime values/timestamps.

### Tavily

Search provider selection is live: `getSearchProvider()` reads
filesDir/agent_preferences.json (outside workspace), then cold config.json, then
Brave. `web_search` with auto/omitted provider uses it; an explicit provider argument
overrides it. Cache keys include provider, query and count, so Tavily does not reuse
a cached Brave response just because the query matches.

Tavily credentials and provider selection have DIFFERENT lifetimes. web.js reads
`config.tavilyApiKey` in the running process. Android-managed keys are copied into
config.json on service start; changing the provider alone does not prove a usable
Tavily key was loaded. Agent-settings apiKeys sync runs at config startup in the
shipped path; its helper is exported but no later caller is wired. Android keys
also take precedence over conversational keys. The system prompt's blanket promise
that newly saved keys are immediately live is therefore not supported by this path.

Offline routing tests prove that Tavily selection calls the Tavily handler and that
a missing key fails; a synthetic configured key builds the expected Tavily request.
No paid search or real credential validity was tested. Actual live provider/key
presence/search success remain unconfirmed.

## 5. Temporarily disabling Rich

Reasonable A/B mitigation, not a lossless-delivery fix. The Settings richMessages
flag is read into a const at config load and destructured by telegram.js. It needs
a controlled service restart to change this running process; editing a live overlay
alone does not disable it. Settings config overrides the environment flag.

With Rich disabled, sendRichMessage is skipped and classic HTML/plain is used.
Offline tests confirm both successful classic delivery and the SAME unresolved
ETIMEDOUT loss behavior when classic transport fails. Smaller classic chunks and a
different method may help isolate a Rich-specific symptom, but more chunks can also
mean more requests. Do not promise it cures mobile-network timeouts. No user toggle
or restart was performed here.

## Actual tests

- `node --test tests/diagnostics/osz-delivery-settings.test.js`: 27/27 PASS.
- Existing scripts PASS: telegram-rich-send, telegram-no-double-delivery,
  telegram-systemplain, rich-messages-default, interim-delivery, agent-preferences,
  recent-sessions-heartbeat-filter, bridge-health-regression.
- Node smoke PASS (known pre-existing seven uncovered-load warnings remain).
- Total: 10/10 executed scripts PASS. These are offline mocks/source-extracted
  settings/scheduler tests and source guards, not production Telegram E2E.
- No Android compile/JVM run, CI dispatch or APK build triggered for this diagnosis.

Synthetic test logs are local/ignored under app/build/outputs/osz-diagnostics/.
Only this report and the diagnostic test are new tracked-candidate files.

## Remaining read-only phone evidence

Need sanitized per-turn timing/maxSteps and current non-secret values only:
agent_settings maxStepsPerTurn/heartbeatIntervalMinutes; running cold fallback values;
agent_preferences searchProvider; boolean Tavily-key-present (NEVER the key);
rich flag and the timeout phase/cause. Relevant log fragments include
`[Config] Failed to write agent_settings.json`, `[Heartbeat] Interval set ...`,
`[Heartbeat] Running probe...`, provider-specific search failures and the affected
turn's trace. Do not export or publish full config files, secrets, raw conversations
or private memory. Obtain through authorized read-only ADB or a narrowly filtered
on-device diagnostic, not by bypassing Android app isolation.
