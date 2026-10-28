package com.seekerclaw.app.ui.settings

/** Rich formatting is read live; channel/credential changes retain the restart gate. */
internal object ChannelSettingsPolicy {
    fun requiresRestart(field: String): Boolean = field != "richMessages"
}
