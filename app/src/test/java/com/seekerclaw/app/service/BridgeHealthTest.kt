package com.seekerclaw.app.service

import org.junit.Assert.assertEquals
import org.junit.Test

class BridgeHealthTest {
    @Test
    fun `healthy node and healthy bridge stays healthy`() {
        val action = decideBridgeHealthAction(
            nodeAlive = true,
            bridgeHealthy = true,
            userStopRequested = false,
            attempts = 0,
            maxAttempts = 3,
            nowMs = 10_000L,
            lastAttemptMs = 0L,
            backoffMs = 1_000L,
        )

        assertEquals(BridgeHealthAction.Healthy, action)
    }

    @Test
    fun `broken bridge with live node requests recovery on repeated start`() {
        val action = decideBridgeHealthAction(
            nodeAlive = true,
            bridgeHealthy = false,
            userStopRequested = false,
            attempts = 0,
            maxAttempts = 3,
            nowMs = 10_000L,
            lastAttemptMs = 0L,
            backoffMs = 1_000L,
        )

        assertEquals(BridgeHealthAction.RecoverBridge, action)
    }

    @Test
    fun `dead node restarts runtime`() {
        val action = decideBridgeHealthAction(
            nodeAlive = false,
            bridgeHealthy = false,
            userStopRequested = false,
            attempts = 0,
            maxAttempts = 3,
            nowMs = 10_000L,
            lastAttemptMs = 0L,
            backoffMs = 1_000L,
        )

        assertEquals(BridgeHealthAction.RestartRuntime, action)
    }

    @Test
    fun `temporary bridge failure waits during retry backoff`() {
        val action = decideBridgeHealthAction(
            nodeAlive = true,
            bridgeHealthy = false,
            userStopRequested = false,
            attempts = 1,
            maxAttempts = 3,
            nowMs = 10_500L,
            lastAttemptMs = 10_000L,
            backoffMs = 2_000L,
        )

        assertEquals(BridgeHealthAction.WaitBackoff, action)
    }

    @Test
    fun `normal recovery after temporary failure is healthy`() {
        val action = decideBridgeHealthAction(
            nodeAlive = true,
            bridgeHealthy = true,
            userStopRequested = false,
            attempts = 2,
            maxAttempts = 3,
            nowMs = 20_000L,
            lastAttemptMs = 10_000L,
            backoffMs = 4_000L,
        )

        assertEquals(BridgeHealthAction.Healthy, action)
    }

    @Test
    fun `exhausted bridge recovery restarts runtime instead of looping forever`() {
        val action = decideBridgeHealthAction(
            nodeAlive = true,
            bridgeHealthy = false,
            userStopRequested = false,
            attempts = 3,
            maxAttempts = 3,
            nowMs = 20_000L,
            lastAttemptMs = 10_000L,
            backoffMs = 1_000L,
        )

        assertEquals(BridgeHealthAction.RestartRuntime, action)
    }

    @Test
    fun `user stop stays stopped and does not auto restart`() {
        val action = decideBridgeHealthAction(
            nodeAlive = true,
            bridgeHealthy = false,
            userStopRequested = true,
            attempts = 3,
            maxAttempts = 3,
            nowMs = 20_000L,
            lastAttemptMs = 10_000L,
            backoffMs = 1_000L,
        )

        assertEquals(BridgeHealthAction.Stopped, action)
    }

    @Test
    fun `backoff is bounded`() {
        assertEquals(1_000L, bridgeRecoveryBackoffMs(0))
        assertEquals(2_000L, bridgeRecoveryBackoffMs(1))
        assertEquals(30_000L, bridgeRecoveryBackoffMs(99))
    }
}
