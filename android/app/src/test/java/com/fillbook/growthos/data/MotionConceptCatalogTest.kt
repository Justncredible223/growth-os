package com.fillbook.growthos.data

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** GET /api/run-campaign as the Create Fillbook Video dialog reads it: the concepts on offer, the used-up ones, the one-a-day state. */
class MotionConceptCatalogTest {
    private val body = """
        {
          "motionConcepts": [
            {"id":"daily-02-orb-setup","title":"One setup: 8 trades, 25% win, lost ${'$'}422","hook":"One setup wins only 25%.","topic":"Setup report","day":2},
            {"id":"daily-03-busy-day","title":"6 trades against a norm of 2.7","hook":"6 trades.","topic":"Busy days","day":3}
          ],
          "nextConceptId": "daily-02-orb-setup",
          "dailyLimit": {"requestedToday": "Motion concept request: ${'$'}1,725 to the floor, ${'$'}1,000 left today", "nextRequestAt": "2026-10-05T04:00:00.000Z"},
          "unavailableMotionConcepts": [
            {"id":"daily-05-size-over-plan","title":"5 contracts against a plan of 3","day":5,"state":"waiting"},
            {"id":"daily-01-brief-room","title":"${'$'}1,725 to the floor, ${'$'}1,000 left today","day":1,"state":"made"}
          ]
        }
    """.trimIndent()

    @Test
    fun `reads each concept with its day, and which one is next`() {
        val catalog = parseMotionConceptCatalog(JSONObject(body))
        assertEquals(listOf(2, 3), catalog.concepts.map { it.day })
        assertEquals("daily-02-orb-setup", catalog.nextConceptId)
    }

    @Test
    fun `reads the one-a-day state and drops the request prefix from today's concept`() {
        val limit = parseMotionConceptCatalog(JSONObject(body)).dailyLimit
        assertEquals("${'$'}1,725 to the floor, ${'$'}1,000 left today", limit.requestedToday)
        assertEquals("2026-10-05T04:00:00.000Z", limit.nextRequestAt)
    }

    @Test
    fun `lists the used-up concepts in day order with their state`() {
        val unavailable = parseMotionConceptCatalog(JSONObject(body)).unavailable
        assertEquals(listOf(1, 5), unavailable.map { it.day })
        assertEquals(listOf("made", "waiting"), unavailable.map { it.state })
    }

    @Test
    fun `an older server with none of the new fields still parses`() {
        val old = JSONObject("""{"motionConcepts":[{"id":"a","title":"A","hook":"h","topic":"t"}]}""")
        val catalog = parseMotionConceptCatalog(old)
        assertEquals(1, catalog.concepts.size)
        assertNull(catalog.concepts[0].day)
        assertNull(catalog.dailyLimit.requestedToday)
        assertNull(catalog.dailyLimit.nextRequestAt)
        assertNull(catalog.nextConceptId)
        assertEquals(emptyList<UnavailableMotionConcept>(), catalog.unavailable)
    }

    @Test
    fun `a free day has a null limit, including when the server sends the string null`() {
        val free = JSONObject("""{"motionConcepts":[],"dailyLimit":{"requestedToday":null,"nextRequestAt":null}}""")
        val limit = parseMotionConceptCatalog(free).dailyLimit
        assertNull(limit.requestedToday)
        assertNull(limit.nextRequestAt)
    }
}
