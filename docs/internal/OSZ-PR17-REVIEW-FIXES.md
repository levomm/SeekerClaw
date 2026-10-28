# PR #17 — eight Codex findings (review 5677022913)

Branch: `fix/osz-delivery-runtime-settings`. The reviewed `e3a88b5` APK is
superseded/provisional and must not be presented as the final update.
No merge, installation or device-data changes are part of this follow-up.

| User priority | Review comment | Repair | Regression |
|---|---|---|---|
| 1 | 4396305273 (P1) | Parse the actual string arguments accepted by the command dispatcher. | `osz-delivery-runtime`: real handleMessage `/outbox show <id>` sends saved text without another AI turn; whitespace, invalid ID and foreign chat checks. |
| 2 | 4396305293 | All post-attempt state-write errors remain DELIVERY_PENDING; durable ATTEMPTING fences replay. | Same suite: POST timeout **and** successful remote ACK followed by ENOSPC, through the real handler; exactly one POST, no generic error reply, no done/stats, preserved text and no replay. |
| 3 | 4396305279 | Full preference preimage rollback, runtime and agent-preference preimages restored on overlay failure; attempt all restores even if one fails. Prior prefs/runtime/agent save-failure paths also restore all preference fields. Preserve migrated long names on trusted rollback. | `SettingsPublicationTest` (success, all-store rollback, thrown publisher, independent rollback failure, migrated-name preservation, blank-name rejection), plus ConfigManager wiring guard. |
| 4 | 4396305280 | Clear fully acknowledged response text; retain only a 24-hour dedup tombstone. Best-effort, throttled ACK-only cleanup on activity; never delete pending/crashed/corrupt/inconsistent records. | `osz-delivery-runtime`: ACK text removal, expired versus recent tombstone, READY/uncertain/rejected/ATTEMPTING/corrupt/inconsistent preservation. |
| 5 | 4396305288 | Partition storage and delivery hashes by stable bot identity, not secret token material. | Same suite: different bots with identical chat/input IDs do not collide/leak/suppress; rotating the same bot's token retains pending recovery. |
| 6 | 4396305284 | Track conversational credential ownership; valid removal/blank clears only that file-owned mapping. | Same suite: refresh, malformed snapshot retention, blank/removal revocation, immutable Android precedence and unrelated-owner preservation. Synthetic keys only. |
| 7 | 4396305282 | Both full prompt formatting branches and diagnostics describe live Rich behavior. | Same suite executes both actual formatting branches and checks live/no-restart wording; compact prompt knowledge probe remains gated. |
| 8 | 4396305297 | Actual ChannelConfigScreen uses a tested Rich restart exemption and live help copy; other fields retain their restart gate. | `ChannelSettingsPolicyTest` (Rich, channel/credentials, unknown fields), plus actual-screen wiring/copy guard. |

The added automated cases are offline/JVM checks, not Android UI instrumentation,
real Telegram/Tavily calls, a full live-model SAB or phone E2E. Exact commit, CI
results and fresh review receipt are recorded in PR #17 after execution. Original
review threads must receive substantive proof before resolution; a resolved flag
alone is not evidence.

The production Android Bridge/service/watchdog/STOP implementation stays at the
previous bridge-recovery baseline. Tests do not read or mutate osZ's private
identity, workspace memory, database, config or real API credentials.
