package com.seekerclaw.app.ui.settings

import org.junit.Assert.*
import org.junit.Test

class ChannelSettingsPolicyTest {
    @Test
    fun `Rich toggle never requests a restart`() {
        assertFalse(ChannelSettingsPolicy.requiresRestart("richMessages"))
    }

    @Test
    fun `channel and credential edits keep the existing restart requirement`() {
        for (field in listOf("channel", "telegramBotToken", "discordBotToken", "telegramOwnerId")) {
            assertTrue(field, ChannelSettingsPolicy.requiresRestart(field))
        }
    }

    @Test
    fun `unknown edits conservatively require restart`() {
        assertTrue(ChannelSettingsPolicy.requiresRestart("unknown"))
    }
}
