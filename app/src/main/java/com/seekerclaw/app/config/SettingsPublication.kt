package com.seekerclaw.app.config

/** The final live-overlay commit either succeeds or attempts EVERY prior-store rollback. */
internal object SettingsPublication {
    data class Result(
        val published: Boolean,
        val prefsRestored: Boolean = true,
        val runtimeRestored: Boolean = true,
        val agentPrefsRestored: Boolean = true,
    )

    fun finish(
        publish: () -> Boolean,
        restorePrefs: () -> Boolean,
        restoreRuntime: () -> Boolean,
        restoreAgentPrefs: () -> Boolean,
    ): Result {
        if (runCatching(publish).getOrDefault(false)) return Result(published = true)
        return Result(
            published = false,
            prefsRestored = runCatching(restorePrefs).getOrDefault(false),
            runtimeRestored = runCatching(restoreRuntime).getOrDefault(false),
            agentPrefsRestored = runCatching(restoreAgentPrefs).getOrDefault(false),
        )
    }
}
