package com.batonai.download

import java.io.ByteArrayOutputStream
import java.io.OutputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import org.junit.Assert.*
import org.junit.Test

class LocalImageOperationTest {
  private class Entry(val fail: String? = null, val onWrite: (() -> Unit)? = null) : PendingLocalImage {
    val bytes = ByteArrayOutputStream()
    var closed = false
    var published = false
    var deleted = false
    override fun open(): OutputStream {
      check(fail != "open") { "open failed" }
      return object : OutputStream() {
        override fun write(value: Int) { bytes.write(value) }
        override fun write(buffer: ByteArray, offset: Int, length: Int) {
          check(fail != "write") { "write failed" }
          bytes.write(buffer, offset, length); onWrite?.invoke()
        }
        override fun flush() { check(fail != "flush") { "flush failed" } }
        override fun close() { closed = true; check(fail != "close") { "close failed" } }
      }
    }
    override fun publish() { check(closed); check(fail != "publish") { "publish failed" }; published = true }
    override fun delete() { check(fail != "delete") { "delete failed" }; deleted = true; bytes.reset() }
  }

  @Test fun savesExactBytesAndProgressBeforePublishingClosedFile() {
    val bytes = ByteArray(150001) { (it % 255).toByte() }
    val entry = Entry(); val progress = mutableListOf<Pair<Long, Long>>()
    LocalImageOperation().save(LocalImageData("image/png", bytes), { entry }) { n, t -> progress.add(n to t) }
    assertArrayEquals(bytes, entry.bytes.toByteArray()); assertTrue(entry.closed && entry.published)
    assertEquals(0L to bytes.size.toLong(), progress.first())
    assertEquals(bytes.size.toLong() to bytes.size.toLong(), progress.last())
    assertFalse(entry.deleted)
  }

  @Test fun failedWritesAndPublishDeleteTheirPartialEntry() {
    for (stage in listOf("open", "write", "flush", "close", "publish")) {
      val entry = Entry(stage)
      assertThrows(Exception::class.java) {
        LocalImageOperation().save(LocalImageData("image/png", byteArrayOf(1)), { entry }) { _, _ -> }
      }
      assertTrue(stage, entry.deleted); assertFalse(entry.published)
    }
  }

  @Test fun cancellationDuringWriteWaitsForCloseAndCleanup() {
    val first = CountDownLatch(1); val resume = CountDownLatch(1)
    val entry = Entry(onWrite = { first.countDown(); check(resume.await(5, TimeUnit.SECONDS)) })
    val operation = LocalImageOperation(); val failure = AtomicReference<Throwable?>()
    val worker = Thread {
      try { operation.save(LocalImageData("image/png", ByteArray(150001) { 42 }), { entry }) { _, _ -> } }
      catch (error: Throwable) { failure.set(error) }
    }
    worker.start()
    assertTrue(first.await(5, TimeUnit.SECONDS)); assertTrue(operation.cancel())
    assertFalse(entry.deleted); resume.countDown(); worker.join(5000)
    assertFalse(worker.isAlive); assertEquals("Download cancelled", failure.get()?.message)
    assertTrue(entry.closed && entry.deleted); assertFalse(entry.published)
  }

  @Test fun earlyCancelCreatesNothingAndLateCancelPreservesTheSavedFile() {
    val image = LocalImageData("image/png", byteArrayOf(42))
    val early = LocalImageOperation(); early.cancel(); var created = false
    assertThrows(Exception::class.java) { early.save(image, { created = true; Entry() }) { _, _ -> } }
    assertFalse(created)
    val late = LocalImageOperation(); val entry = Entry()
    late.save(image, { entry }) { _, _ -> }
    assertFalse(late.cancel()); assertTrue(entry.published); assertFalse(entry.deleted)
  }

  @Test fun cleanupFailureDoesNotPretendCancellationSucceeded() {
    val operation = LocalImageOperation(); val entry = Entry("delete")
    val error = assertThrows(Exception::class.java) {
      operation.save(LocalImageData("image/png", ByteArray(150001)), { entry }) { n, _ -> if (n > 0) operation.cancel() }
    }
    assertTrue(error.message!!.contains("could not remove")); assertFalse(entry.deleted)
  }
}
