package com.batonai.download

import android.Manifest
import android.app.Activity
import android.app.DownloadManager
import android.content.BroadcastReceiver
import android.content.ClipData
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.Uri
import android.os.Build
import android.os.Environment
import app.tauri.PermissionState
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.Permission
import app.tauri.annotation.PermissionCallback
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

@InvokeArg
class DownloadArgs {
  lateinit var url: String
  lateinit var name: String
  var mime: String = "application/octet-stream"
}

@TauriPlugin(permissions = [Permission(strings = [Manifest.permission.WRITE_EXTERNAL_STORAGE], alias = "legacyStorage")])
class FileDownloadPlugin(private val activity: Activity) : Plugin(activity) {
  private data class PendingDownload(val id: Long, val name: String, val mime: String, val invoke: Invoke)

  private var pending: PendingDownload? = null
  private var foreground = true
  private var receiverRegistered = false
  private val receiver = object : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
      if (intent.action == DownloadManager.ACTION_DOWNLOAD_COMPLETE
        && intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1) == pending?.id) shareCompletedDownload()
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

  override fun onPause() { foreground = false }

  override fun onResume() {
    foreground = true
    shareCompletedDownload()
  }

  override fun onDestroy() {
    pending?.invoke?.reject("Download continues in system Downloads. Open the file there when it finishes.")
    clearPendingDownload()
  }

  private fun clearPendingDownload() {
    if (receiverRegistered) {
      activity.unregisterReceiver(receiver)
      receiverRegistered = false
    }
    pending = null
  }

  private fun shareCompletedDownload() {
    val download = pending ?: return
    if (!foreground || activity.isFinishing || activity.isDestroyed) return
    try {
      val manager = activity.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
      val status = manager.query(DownloadManager.Query().setFilterById(download.id)).use { cursor ->
        require(cursor != null && cursor.moveToFirst()) { "The download is no longer available" }
        cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS))
      }
      require(status != DownloadManager.STATUS_FAILED) { "Download failed. Check your connection and available storage." }
      if (status != DownloadManager.STATUS_SUCCESSFUL) return
      val uri = manager.getUriForDownloadedFile(download.id) ?: error("The downloaded file is unavailable")
      val share = Intent(Intent.ACTION_SEND).setType(download.mime)
        .putExtra(Intent.EXTRA_STREAM, uri)
        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      share.clipData = ClipData.newRawUri(download.name, uri)
      activity.startActivity(Intent.createChooser(share, null))
      clearPendingDownload()
      val result = JSObject()
      result.put("status", "share_opened")
      result.put("id", download.id)
      download.invoke.resolve(result)
    } catch (error: Exception) {
      clearPendingDownload()
      download.invoke.reject(error.message ?: "Could not share the downloaded file")
    }
  }

  private fun enqueue(invoke: Invoke) = activity.runOnUiThread {
    if (pending != null) {
      invoke.reject("A download is already in progress")
      return@runOnUiThread
    }
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
      val filter = IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        activity.registerReceiver(receiver, filter, Context.RECEIVER_EXPORTED)
      } else {
        activity.registerReceiver(receiver, filter)
      }
      receiverRegistered = true
      pending = PendingDownload(manager.enqueue(request), name, args.mime, invoke)
      shareCompletedDownload()
    } catch (error: Exception) {
      clearPendingDownload()
      invoke.reject(error.message ?: "Download failed")
    }
  }
}
