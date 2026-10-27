package com.seekerclaw.app.service

import org.junit.Assert.assertEquals
import org.junit.Test

class RuntimeHealthTest {
    @Test fun `live Node and failed authenticated ping are unhealthy`() {
        assertEquals(RuntimeHealth.BRIDGE_UNAVAILABLE, runtimeHealth(true, false, true))
    }

    @Test fun `healthy requires both live Node and verified bridge`() {
        assertEquals(RuntimeHealth.HEALTHY, runtimeHealth(true, true, true))
    }

    @Test fun `good ping cannot hide Node death`() {
        assertEquals(RuntimeHealth.NODE_UNAVAILABLE, runtimeHealth(false, true, true))
        assertEquals(RuntimeHealth.NODE_UNAVAILABLE, runtimeHealth(false, false, true))
    }

    @Test fun `STOP overrides all Node and bridge combinations`() {
        for (node in listOf(false, true)) {
            for (bridge in listOf(false, true)) {
                assertEquals(RuntimeHealth.STOPPED, runtimeHealth(node, bridge, false))
            }
        }
    }

    @Test fun `watchdog observes recovery and later failure truthfully`() {
        assertEquals(RuntimeHealth.BRIDGE_UNAVAILABLE, runtimeHealth(true, false, true))
        assertEquals(RuntimeHealth.HEALTHY, runtimeHealth(true, true, true))
        assertEquals(RuntimeHealth.BRIDGE_UNAVAILABLE, runtimeHealth(true, false, true))
    }
}
