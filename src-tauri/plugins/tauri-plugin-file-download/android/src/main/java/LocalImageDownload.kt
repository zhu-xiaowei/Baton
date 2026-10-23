package com.batonai.download

import java.io.OutputStream

internal interface PendingLocalImage {
  fun open(): OutputStream
  fun publish()
  fun delete()
}

internal class LocalImageOperation {
  private var cancelled = false
  private var committed = false

  @Synchronized fun cancel(): Boolean {
    if (committed) return false
    cancelled = true
    return true
  }

  @Synchronized fun isCancelled() = cancelled

  @Synchronized private fun checkActive() {
    check(!cancelled) { "Download cancelled" }
  }

  fun <T : PendingLocalImage> save(
    image: LocalImageData, create: () -> T, progress: (Long, Long) -> Unit
  ): T {
    checkActive()
    val pending = create()
    try {
      pending.open().use { output ->
        progress(0, image.bytes.size.toLong())
        for (offset in image.bytes.indices step (64 * 1024)) {
          checkActive()
          val count = minOf(64 * 1024, image.bytes.size - offset)
          output.write(image.bytes, offset, count)
          progress((offset + count).toLong(), image.bytes.size.toLong())
        }
        checkActive()
        output.flush()
      }
      synchronized(this) {
        checkActive()
        pending.publish()
        committed = true
      }
      return pending
    } catch (error: Exception) {
      try { pending.delete() }
      catch (cleanup: Exception) {
        throw IllegalStateException("Local export failed; could not remove the partial Downloads entry", cleanup)
      }
      throw error
    }
  }
}

internal sealed class SavedDownload(val name: String, val mime: String) {
  abstract val id: String
  class Managed(val downloadId: Long, name: String, mime: String) : SavedDownload(name, mime) {
    override val id = downloadId.toString()
  }
  class Local(val uri: String, name: String, mime: String) : SavedDownload(name, mime) {
    override val id = "local:$uri"
  }
}
