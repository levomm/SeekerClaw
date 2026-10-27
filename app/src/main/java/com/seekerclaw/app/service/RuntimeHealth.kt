package com.seekerclaw.app.service

/** Bridge failure is unhealthy but must not enter Node's process-restart path. */
internal enum class RuntimeHealth {
    HEALTHY, BRIDGE_UNAVAILABLE, NODE_UNAVAILABLE, STOPPED,
}

internal fun runtimeHealth(
    nodeAlive: Boolean,
    bridgeHealthy: Boolean,
    serviceRequested: Boolean,
): RuntimeHealth = when {
    !serviceRequested -> RuntimeHealth.STOPPED
    !nodeAlive -> RuntimeHealth.NODE_UNAVAILABLE
    !bridgeHealthy -> RuntimeHealth.BRIDGE_UNAVAILABLE
    else -> RuntimeHealth.HEALTHY
}
