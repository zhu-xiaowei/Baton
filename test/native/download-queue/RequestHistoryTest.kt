package com.batonai.download

import org.junit.Assert.*
import org.junit.Test

class RequestHistoryTest {
  @Test fun receiptCommandsMatchTheFrontendIPCNames() {
    val commands = FileDownloadPlugin::class.java.declaredMethods
      .filter { it.isAnnotationPresent(app.tauri.annotation.Command::class.java) }
      .map { it.name }.toSet()
    assertTrue(commands.containsAll(setOf("download", "cancel", "open_download", "reveal_download")))
  }

  private fun rejection(history: RequestHistory, id: String): String? =
    try { history.check(id); null } catch (error: IllegalStateException) { error.message }

  @Test fun cancelBeforeStartAndRepeatedCancelRemainCancelled() {
    val history = RequestHistory { 0L }
    history.record("one", true)
    history.record("one", true)
    history.record("one", false)
    assertEquals("Download cancelled", rejection(history, "one"))
    history.check("other")
  }

  @Test fun lateCancelDoesNotTurnCompletedRequestIntoCancellation() {
    val history = RequestHistory { 0L }
    history.record("saved", false)
    history.record("saved", true)
    assertEquals("requestId has already been used", rejection(history, "saved"))
  }

  @Test fun historyExpiresAndIsBounded() {
    var time = 0L
    val history = RequestHistory { time }
    repeat(300) { history.record(it.toString(), true) }
    history.check("0")
    assertEquals("Download cancelled", rejection(history, "299"))
    time = 60_000
    history.check("299")
  }

  @Test fun omittedIdIsAllowedAndInvalidIdsAreRejected() {
    val history = RequestHistory { 0L }
    history.check(null)
    history.record(null, true)
    history.check("a".repeat(128))
    for (id in listOf("", "a".repeat(129), "字".repeat(43))) {
      try { history.validate(id); fail("Accepted invalid request ID") }
      catch (_: IllegalArgumentException) { }
    }
  }
}
