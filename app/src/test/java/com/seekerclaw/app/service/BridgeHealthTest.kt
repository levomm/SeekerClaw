package com.seekerclaw.app.service

import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
import java.nio.file.Files
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

class BridgeHealthTest {
    private class Harness {
        @Volatile var stopped = false
        var nodeAlive = true
        var healthy = false
        var startSucceeds = true
        var binds = 0
        var errors = 0
        var exhausted = 0
        var running = false
        val waits = mutableListOf<Long>()
        var duringWait: (() -> Unit)? = null
        val recovery = BridgeRecovery(
            shouldRun = { !stopped },
            probe = { healthy },
            start = { binds++; healthy = startSucceeds; startSucceeds },
            waitMs = { waits.add(it); duringWait?.invoke() },
            onUnhealthy = { errors++; running = false },
            onAttempt = {},
            onExhausted = { exhausted++ },
            onHealthy = { running = canPublishRunning(nodeAlive, !stopped) },
        )
        fun check(): Boolean = runBlocking { recovery.ensureHealthy() }
    }

    @Test fun `P1 successful bind without authenticated healthy ping exhausts budget`() = runBlocking {
        var attempts = 0
        var published = 0
        val recovery = BridgeRecovery({ true }, { false }, { attempts++; true }, {}, {}, {}, {},
            onHealthy = { published++ })
        repeat(20) { assertFalse(recovery.ensureHealthy()) }
        assertEquals(3, attempts)
        assertEquals(0, published)
    }

    @Test fun `P1 health probe start verify and state publication all run off calling thread`() = runBlocking {
        val caller = Thread.currentThread()
        val seen = mutableListOf<String>()
        var healthy = false
        fun record(phase: String) {
            assertNotSame("$phase must run off-main", caller, Thread.currentThread())
            seen.add(phase)
        }
        val recovery = BridgeRecovery(
            { true },
            { record("probe"); healthy },
            { record("start"); healthy = true; true },
            { record("backoff") }, { record("error") }, { record("attempt") }, {},
            onHealthy = { record("running") },
        )
        assertTrue(recovery.ensureHealthy())
        assertEquals(listOf("probe", "error", "backoff", "probe", "attempt", "start", "probe", "running"), seen)
    }

    @Test fun `P2 watchdog-style recovery changes ERROR back to RUNNING`() {
        val h = Harness()
        assertTrue(h.check())
        assertTrue(h.running)
        assertEquals(1, h.errors)
        h.healthy = false
        assertTrue(h.check())
        assertTrue(h.running)
        assertEquals(2, h.errors)
    }

    @Test fun `P2 healthy bridge cannot publish RUNNING if Node died during recovery`() {
        val h = Harness()
        h.duringWait = { h.nodeAlive = false }
        assertTrue(h.check())
        assertFalse(h.running)
        assertFalse(canPublishRunning(false, true))
        assertFalse(canPublishRunning(true, false))
    }

    @Test fun `P2 concurrent reentry serializes entire probe start verify transaction`() {
        val h = Harness()
        val threads = (1..10).map { Thread { h.check() } }
        threads.forEach { it.start() }
        threads.forEach { it.join(5000) }
        assertTrue(threads.none { it.isAlive })
        assertEquals(1, h.binds)
        assertEquals(1, h.errors)
        assertTrue(h.running)
    }

    @Test fun `P2 teardown waits for recovery transaction`() {
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        val events = mutableListOf<String>()
        val recovery = BridgeRecovery({ true }, { false }, {
            events.add("start")
            entered.countDown()
            assertTrue(release.await(5, TimeUnit.SECONDS))
            events.add("start-done")
            false
        }, {}, {}, {}, {}, maxAttempts = 1)
        val worker = Thread { runBlocking { recovery.ensureHealthy() } }
        worker.start()
        assertTrue(entered.await(5, TimeUnit.SECONDS))
        val shutdown = Thread { runBlocking { recovery.shutdown { events.add("shutdown") } } }
        shutdown.start()
        release.countDown()
        worker.join(5000)
        shutdown.join(5000)
        assertFalse(worker.isAlive)
        assertFalse(shutdown.isAlive)
        assertEquals(listOf("start", "start-done", "shutdown"), events)
    }

    @Test fun `healthy repeated start does not bind again`() {
        val h = Harness()
        assertTrue(h.check())
        repeat(20) { assertTrue(h.check()) }
        assertEquals(1, h.binds)
    }

    @Test fun `port conflict is bounded and repeated start cannot reset budget`() {
        val h = Harness().apply { startSucceeds = false }
        repeat(20) { assertFalse(h.check()) }
        assertEquals(3, h.binds)
        assertEquals(listOf(1000L, 2000L, 4000L), h.waits)
        assertEquals(1, h.exhausted)
        assertFalse(h.running)
    }

    @Test fun `temporary probe failure recovers without rebinding healthy listener`() {
        val h = Harness()
        h.duringWait = { h.healthy = true }
        assertTrue(h.check())
        assertEquals(0, h.binds)
    }

    @Test fun `failed bind then normal recovery`() {
        val h = Harness().apply { startSucceeds = false }
        h.duringWait = { if (h.binds == 1) h.startSucceeds = true }
        assertTrue(h.check())
        assertEquals(2, h.binds)
        assertEquals(0, h.exhausted)
    }

    @Test fun `STOP before check never probes or binds`() {
        val h = Harness().apply { stopped = true }
        assertFalse(h.check())
        assertEquals(0, h.binds)
        assertEquals(0, h.errors)
        assertTrue(h.waits.isEmpty())
    }

    @Test fun `STOP during backoff cancels recovery and prevents RUNNING`() {
        val h = Harness()
        h.duringWait = { h.stopped = true }
        assertFalse(h.check())
        assertEquals(0, h.binds)
        assertEquals(0, h.exhausted)
        assertFalse(h.running)
    }

    @Test fun `STOP during start never reports healthy`() = runBlocking {
        var stopped = false
        var published = false
        val recovery = BridgeRecovery({ !stopped }, { false }, { stopped = true; true }, {}, {}, {}, {},
            onHealthy = { published = true })
        assertFalse(recovery.ensureHealthy())
        assertFalse(published)
    }

    @Test fun `observed recovery replenishes budget for a later outage`() {
        val h = Harness().apply { startSucceeds = false }
        assertFalse(h.check())
        h.healthy = true
        assertTrue(h.check())
        h.healthy = false
        h.startSucceeds = true
        assertTrue(h.check())
        assertEquals(4, h.binds)
    }

    @Test fun `STOP persists across process instances until explicit START`() {
        val dir = Files.createTempDirectory("bridge-stop-test").toFile()
        try {
            val file = java.io.File(dir, "service_user_stopped")
            UserStopSignal(file).stop()
            assertTrue(UserStopSignal(file).isStopped())
            UserStopSignal(file).explicitStart()
            assertFalse(UserStopSignal(file).isStopped())
            assertTrue(dir.listFiles()!!.isEmpty())
        } finally { dir.deleteRecursively() }
    }
}
