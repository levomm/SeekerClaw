package com.seekerclaw.app.service

import com.seekerclaw.app.util.LogCollector
import com.seekerclaw.app.util.LogLevel
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

object Watchdog {
    const val CHECK_INTERVAL_MS = 30_000L
    const val DEAD_AFTER_CHECKS = 2 // Node death only; Bridge recovery has its own bounded budget.

    private var watchdogJob: Job? = null
    private val scope = CoroutineScope(Dispatchers.IO)

    internal fun start(
        onDead: () -> Unit,
        checkHealth: suspend () -> RuntimeHealth,
    ) {
        stop()
        LogCollector.append("[Watchdog] Started (interval=${CHECK_INTERVAL_MS / 1000}s, deadAfter=$DEAD_AFTER_CHECKS missed checks)")

        watchdogJob = scope.launch {
            var missedNodeChecks = 0
            var previousHealth: RuntimeHealth? = null
            // Wait for initial startup before checking.
            delay(CHECK_INTERVAL_MS * 2)

            while (isActive) {
                delay(CHECK_INTERVAL_MS)
                val health = checkHealth()
                if (!isActive) break
                when (health) {
                    RuntimeHealth.NODE_UNAVAILABLE -> {
                        missedNodeChecks++
                        LogCollector.append("[Watchdog] Node.js unavailable (missed=$missedNodeChecks/$DEAD_AFTER_CHECKS)", LogLevel.WARN)
                        if (missedNodeChecks >= DEAD_AFTER_CHECKS) {
                            LogCollector.append("[Watchdog] Node.js unavailable, triggering restart...", LogLevel.ERROR)
                            onDead()
                            missedNodeChecks = 0
                        }
                    }
                    RuntimeHealth.BRIDGE_UNAVAILABLE -> {
                        missedNodeChecks = 0
                        if (previousHealth != health) {
                            LogCollector.append("[Watchdog] AndroidBridge unavailable despite live Node.js; runtime remains ERROR, no process restart", LogLevel.WARN)
                        }
                    }
                    RuntimeHealth.HEALTHY -> {
                        missedNodeChecks = 0
                        if (previousHealth != null && previousHealth != RuntimeHealth.HEALTHY) {
                            LogCollector.append("[Watchdog] Node.js and authenticated AndroidBridge health recovered")
                        }
                    }
                    RuntimeHealth.STOPPED -> missedNodeChecks = 0
                }
                previousHealth = health
            }
        }
    }

    fun stop() {
        watchdogJob?.cancel()
        watchdogJob = null
    }
}
