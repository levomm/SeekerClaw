package com.seekerclaw.app.service

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

/** Bounded in-process recovery. Never kills/restarts Node or resets its budget on re-entry. */
internal class BridgeRecovery(
    private val shouldRun: () -> Boolean,
    private val probe: () -> Boolean,
    private val start: () -> Boolean,
    private val waitMs: suspend (Long) -> Unit,
    private val onUnhealthy: () -> Unit,
    private val onAttempt: (Int) -> Unit,
    private val onExhausted: () -> Unit,
    private val maxAttempts: Int = 3,
    private val onHealthy: () -> Unit = {},
) {
    private val mutex = Mutex()
    private var attempts = 0
    private var exhaustedLogged = false

    /** Includes state publication: a stale successful check cannot overwrite a newer ERROR. */
    suspend fun ensureHealthy(): Boolean = withContext(Dispatchers.IO) {
        mutex.withLock { recoverLocked() }
    }

    /** Shares the recovery lock, so teardown cannot race create/start/verify. */
    suspend fun shutdown(action: () -> Unit) = withContext(Dispatchers.IO) {
        mutex.withLock { action() }
    }

    private fun verifiedHealthy(): Boolean {
        if (!shouldRun() || !probe() || !shouldRun()) return false
        attempts = 0
        exhaustedLogged = false
        onHealthy()
        return true
    }

    private suspend fun recoverLocked(): Boolean {
        if (!shouldRun()) return false
        if (verifiedHealthy()) return true
        onUnhealthy()
        while (attempts < maxAttempts && shouldRun()) {
            // 1s, 2s, 4s; the caller supplies a cancellable/lifecycle-aware wait.
            waitMs(1_000L shl attempts)
            if (!shouldRun()) return false
            // A transient failure may have recovered while waiting. Do not rebind a healthy bridge.
            if (verifiedHealthy()) return true
            attempts++
            onAttempt(attempts)
            if (!shouldRun()) return false
            // A successful bind alone MUST NOT reset the budget or publish RUNNING.
            if (start() && verifiedHealthy()) return true
        }
        if (shouldRun() && !exhaustedLogged) {
            exhaustedLogged = true
            onExhausted()
        }
        // Remain ERROR, without automatic process restarts or an endless bind loop.
        // Later checks may observe a healthy listener, but cannot replenish a failed budget.
        return false
    }
}

internal fun canPublishRunning(nodeAlive: Boolean, serviceRequested: Boolean): Boolean =
    nodeAlive && serviceRequested

/** Outside workspace: survives process death and is read fresh by both Android processes. */
internal class UserStopSignal(private val marker: java.io.File) {
    fun isStopped(): Boolean = marker.exists()
    fun stop() { marker.writeText("stopped\n") }
    fun explicitStart() {
        check(!marker.exists() || marker.delete()) { "Cannot clear user stop signal" }
    }
}
