package com.batonai.download

import android.Manifest
import android.app.Activity
import android.app.DownloadManager
import android.content.Context
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.os.Handler
import android.os.Looper
import app.tauri.PermissionState
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.Permission
import app.tauri.annotation.PermissionCallback
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Channel
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

private const val POLL_INTERVAL_MS = 250L

@InvokeArg
class DownloadArgs {
  lateinit var url: String
  lateinit var name: String
  var mime: String = "application/octet-stream"
  var onProgress: Channel? = null
}

@TauriPlugin(permissions = [Permission(strings = [Manifest.permission.WRITE_EXTERNAL_STORAGE], alias = "legacyStorage")])
class FileDownloadPlugin(private val activity: Activity) : Plugin(activity) {
  private class PendingDownload(val invoke: Invoke, val progress: Channel?)

  private val pending = mutableMapOf<Long, PendingDownload>()
  private val handler = Handler(Looper.getMainLooper())
  // DownloadManager has no progress callback, so running downloads are polled until they settle.
  private val poll = object : Runnable {
    override fun run() {
      val manager = activity.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
      for ((id, download) in pending.toList()) {
        try {
          manager.query(DownloadManager.Query().setFilterById(id)).use { cursor ->
            require(cursor != null && cursor.moveToFirst()) { "The download is no longer available" }
            val status = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS))
            require(status != DownloadManager.STATUS_FAILED) { "Download failed. Check your connection and available storage." }
            if (status == DownloadManager.STATUS_SUCCESSFUL) {
              pending.remove(id)
              download.invoke.resolve(JSObject().apply { put("status", "saved") })
            } else {
              val loaded = cursor.getLong(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR))
              val total = cursor.getLong(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES))
              if (total > 0) download.progress?.send(JSObject().apply { put("loaded", loaded); put("total", total) })
            }
          }
        } catch (error: Exception) {
          pending.remove(id)
          download.invoke.reject(error.message ?: "Download failed")
        }
      }
      if (pending.isNotEmpty()) handler.postDelayed(this, POLL_INTERVAL_MS)
    }
  }

  @Command
  fun download(invoke: Invoke) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q && getPermissionState("legacyStorage") != PermissionState.GRANTED) {
      requestPermissionForAlias("legacyStorage", invoke, "storagePermissionCallback")
      return
    }
    enqueue(invoke)
  }

  @PermissionCallback
  fun storagePermissionCallback(invoke: Invoke) {
    if (getPermissionState("legacyStorage") == PermissionState.GRANTED) enqueue(invoke)
    else invoke.reject("Storage permission is required to save to Downloads on this Android version")
  }

  override fun onDestroy() {
    handler.removeCallbacks(poll)
    pending.values.forEach { it.invoke.reject("Download continues in system Downloads. Open the file there when it finishes.") }
    pending.clear()
  }

  private fun enqueue(invoke: Invoke) = activity.runOnUiThread {
    try {
      val args = invoke.parseArgs(DownloadArgs::class.java)
      val uri = Uri.parse(args.url)
      require(uri.scheme == "https" && uri.host != null && uri.userInfo == null) { "Downloads require an HTTPS URL" }
      val name = args.name.replace('\\', '/').substringAfterLast('/').replace(Regex("[\\p{Cntrl}<>:\"|?*]"), "_").trim(' ', '.')
      require(name.isNotEmpty()) { "Invalid filename" }
      val dot = name.lastIndexOf('.')
      val stem = if (dot > 0) name.substring(0, dot) else name
      val extension = if (dot > 0) name.substring(dot) else ""
      val destination = stem.take(60) + "-" + System.currentTimeMillis() + extension.take(20)
      val request = DownloadManager.Request(uri).setTitle(name).setMimeType(args.mime)
        .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
        .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, destination)
      val manager = activity.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
      pending[manager.enqueue(request)] = PendingDownload(invoke, args.onProgress)
      if (pending.size == 1) handler.post(poll)
    } catch (error: Exception) {
      invoke.reject(error.message ?: "Download failed")
    }
  }
}
