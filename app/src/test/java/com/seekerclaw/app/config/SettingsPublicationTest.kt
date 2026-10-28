package com.seekerclaw.app.config

import org.junit.Assert.*
import org.junit.Test
import com.seekerclaw.app.state.AgentPreferences
import com.seekerclaw.app.state.AgentPreferencesStore

class SettingsPublicationTest {
    @Test
    fun `successful publication does not revert committed stores`() {
        var restores = 0
        val result = SettingsPublication.finish({ true }, { restores++; true }, { restores++; true }, { restores++; true })
        assertTrue(result.published)
        assertEquals(0, restores)
    }

    @Test
    fun `failed overlay restores full prefs and both cross process snapshots`() {
        val priorPrefs = mapOf("steps" to "12", "heartbeat" to "60", "rich" to "false", "key" to "opaque-original")
        var prefs = mapOf("steps" to "35", "heartbeat" to "30", "rich" to "true", "key" to "opaque-new")
        var runtime = "new-runtime"
        var agent = "new-agent"
        val result = SettingsPublication.finish(
            publish = { false },
            restorePrefs = { prefs = priorPrefs; true },
            restoreRuntime = { runtime = "original-runtime"; true },
            restoreAgentPrefs = { agent = "original-agent"; true },
        )
        assertFalse(result.published)
        assertEquals(priorPrefs, prefs)
        assertEquals("original-runtime", runtime)
        assertEquals("original-agent", agent)
        assertTrue(result.prefsRestored && result.runtimeRestored && result.agentPrefsRestored)
    }

    @Test
    fun `publisher exception also restores every store`() {
        val restored = mutableListOf<String>()
        val result = SettingsPublication.finish(
            { error("simulated disk error") },
            { restored.add("prefs"); true },
            { restored.add("runtime"); true },
            { restored.add("agent"); true },
        )
        assertFalse(result.published)
        assertEquals(listOf("prefs", "runtime", "agent"), restored)
    }

    @Test
    fun `trusted rollback preserves a migrated over-cap agent name`() {
        AgentPreferencesStore.validateRollbackSnapshot(AgentPreferences(agentName = "a".repeat(100)))
    }

    @Test(expected = IllegalArgumentException::class)
    fun `rollback still rejects a blank-name snapshot`() {
        AgentPreferencesStore.validateRollbackSnapshot(AgentPreferences(agentName = " "))
    }

    @Test
    fun `rollback failure is reported and never skips remaining restorations`() {
        var agentRestored = false
        val result = SettingsPublication.finish(
            { false }, { error("simulated disk full") }, { false }, { agentRestored = true; true },
        )
        assertFalse(result.published)
        assertFalse(result.prefsRestored)
        assertFalse(result.runtimeRestored)
        assertTrue(result.agentPrefsRestored)
        assertTrue(agentRestored)
    }
}
