package com.seekerclaw.app.service

/**
 * Pure bridge-health decision helpers for SeekerClawService.
 *
 * Node.js being alive is not enough: the Node process depends on the
 * AndroidBridge loopback server (127.0.0.1:8765) for stats, wallet,
 * Android tools, provider credential presence, MCP tokens, and signing.
 */
internal enum class BridgeHealthAction {
    Healthy,
    RecoverBridge,
    WaitBackoff,
    RestartRuntime,
    Stopped,
}

internal fun bridgeRecoveryBackoffMs(attempts: Int): Long {
    val clamped = attempts.coerceIn(0, 5)
    return (1_000L shl clamped).coerceAtMost(30_000L)
}

internal fun decideBridgeHealthAction(
    nodeAlive: Boolean,
    bridgeHealthy: Boolean,
    userStopRequested: Boolean,
    attempts: Int,
    maxAttempts: Int,
    nowMs: Long,
    lastAttemptMs: Long,
    backoffMs: Long,
): BridgeHealthAction {
    if (userStopRequested) return BridgeHealthAction.Stopped
    if (!nodeAlive) return BridgeHealthAction.RestartRuntime
    if (bridgeHealthy) return BridgeHealthAction.Healthy
    if (attempts >= maxAttempts) return BridgeHealthAction.RestartRuntime
    if (lastAttemptMs > 0L && nowMs - lastAttemptMs < backoffMs) return BridgeHealthAction.WaitBackoff
    return BridgeHealthAction.RecoverBridge
}
