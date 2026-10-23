package com.batonai.download

import android.content.ContentResolver
import android.content.ContentValues
import android.net.Uri
import android.os.Environment
import android.provider.MediaStore
import android.annotation.TargetApi
import java.io.OutputStream

@TargetApi(29)
internal class MediaStoreImage(private val resolver: ContentResolver, val uri: Uri) : PendingLocalImage {
  override fun open(): OutputStream =
    resolver.openOutputStream(uri, "w") ?: error("Could not write to Downloads")

  override fun publish() {
    val values = ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) }
    check(resolver.update(uri, values, null, null) == 1) { "Could not finish saving to Downloads" }
  }

  override fun delete() {
    check(resolver.delete(uri, null, null) == 1) { "Could not remove partial download" }
  }

  companion object {
    fun create(resolver: ContentResolver, name: String, mime: String): MediaStoreImage {
      val values = ContentValues().apply {
        put(MediaStore.Downloads.DISPLAY_NAME, name)
        put(MediaStore.Downloads.MIME_TYPE, mime)
        put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
        put(MediaStore.Downloads.IS_PENDING, 1)
      }
      val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
        ?: error("Could not create a file in Downloads")
      return MediaStoreImage(resolver, uri)
    }
  }
}
