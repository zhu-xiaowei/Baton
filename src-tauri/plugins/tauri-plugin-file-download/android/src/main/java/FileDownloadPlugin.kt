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
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import app.tauri.plugin.Channel
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
  var onProgress: Channel? = null
  var requestId: String? = null
}

@InvokeArg
class CancelArgs { lateinit var requestId: String }

@InvokeArg
class ReceiptArgs { lateinit var id: String }

@TauriPlugin(permissions = [Permission(strings = [Manifest.permission.WRITE_EXTERNAL_STORAGE], alias = "legacyStorage")])
class FileDownloadPlugin(private val activity: Activity) : Plugin(activity) {
  private data class PendingDownload(val id: Long, val name: String, val mime: String, val invoke: Invoke, val progress: Channel?, val requestId: String?)
  private class LocalDownload(val invoke: Invoke, val requestId: String?) {
    val operation = LocalImageOperation()
    val cancellations = mutableListOf<Invoke>()
  }

  private var pending: PendingDownload? = null
  private var localPending: LocalDownload? = null
  private var waitingPermission: Pair<Invoke, DownloadArgs>? = null
  private val history = RequestHistory { SystemClock.elapsedRealtime() }
  private val receipts = mutableMapOf<String, SavedDownload>()
  private val handler = Handler(Looper.getMainLooper())
  private val poll = object : Runnable {
    override fun run() {
      checkDownload()
      if (pending != null) handler.postDelayed(this, 500)
    }
  }
  private var receiverRegistered = false
  private val receiver = object : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
      if (intent.action == DownloadManager.ACTION_DOWNLOAD_COMPLETE
        && intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1) == pending?.id) checkDownload()
    }
  }

  @Command
  fun download(invoke: Invoke) = activity.runOnUiThread {
    try {
      val args = invoke.parseArgs(DownloadArgs::class.java)
      history.check(args.requestId)
      require(pending == null && localPending == null && waitingPermission == null) { "A download is already in progress" }
      if (args.url.startsWith("data:")) {
        require(Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) { "Saving local images requires Android 10 or newer" }
        saveLocalImage(invoke, args)
      } else if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q && getPermissionState("legacyStorage") != PermissionState.GRANTED) {
        waitingPermission = Pair(invoke, args)
        requestPermissionForAlias("legacyStorage", invoke, "storagePermissionCallback")
      } else enqueue(invoke, args)
    } catch (error: Exception) {
      if (waitingPermission?.first === invoke) waitingPermission = null
      invoke.reject(error.message ?: "Could not start download")
    }
  }

  @PermissionCallback
  fun storagePermissionCallback(invoke: Invoke) = activity.runOnUiThread {
    val waiting = waitingPermission ?: return@runOnUiThread
    if (waiting.first !== invoke) return@runOnUiThread
    waitingPermission = null
    if (getPermissionState("legacyStorage") == PermissionState.GRANTED) enqueue(invoke, waiting.second)
    else {
      history.record(waiting.second.requestId, false)
      invoke.reject("Storage permission is required to save to Downloads on this Android version")
    }
  }

  @Command
  fun cancel(invoke: Invoke) = activity.runOnUiThread {
    try {
      val requestId = invoke.parseArgs(CancelArgs::class.java).requestId
      history.validate(requestId)
      val local = localPending
      if (local?.requestId == requestId) {
        local.operation.cancel()
        local.cancellations.add(invoke)
        return@runOnUiThread
      }
      val download = pending
      val waiting = waitingPermission
      if (download?.requestId == requestId) {
        val manager = activity.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
        manager.remove(download.id)
        clearPendingDownload(cancelled = true)
        download.invoke.reject("Download cancelled")
      } else if (waiting?.second?.requestId == requestId) {
        history.record(requestId, true)
        waitingPermission = null
        waiting.first.reject("Download cancelled")
      } else {
        history.record(requestId, true)
      }
      invoke.resolve()
    } catch (_: Exception) {
      invoke.reject("Could not cancel download")
    }
  }

  override fun onResume() {
    checkDownload()
  }

  override fun onDestroy() {
    localPending?.operation?.cancel()
    waitingPermission?.let {
      history.record(it.second.requestId, true)
      it.first.reject("Download cancelled")
    }
    waitingPermission = null
    pending?.invoke?.reject("Download continues in system Downloads. Open the file there when it finishes.")
    clearPendingDownload()
  }

  private fun clearPendingDownload(cancelled: Boolean = false) {
    pending?.let { history.record(it.requestId, cancelled) }
    if (receiverRegistered) {
      activity.unregisterReceiver(receiver)
      receiverRegistered = false
    }
    handler.removeCallbacks(poll)
    pending = null
  }

  private fun checkDownload() {
    val download = pending ?: return
    if (activity.isFinishing || activity.isDestroyed) return
    try {
      val manager = activity.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
      var received = 0L
      var total = -1L
      val status = manager.query(DownloadManager.Query().setFilterById(download.id)).use { cursor ->
        require(cursor != null && cursor.moveToFirst()) { "The download is no longer available" }
        received = cursor.getLong(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR))
        total = cursor.getLong(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES))
        cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS))
      }
      if (received > 512L * 1024 * 1024 || total > 512L * 1024 * 1024) {
        manager.remove(download.id)
        error("File exceeds 512 MB")
      }
      val progress = JSObject().put("received", received).put("total", if (total > 0) total else org.json.JSONObject.NULL)
        .put("state", if (status == DownloadManager.STATUS_PAUSED) "waiting" else "downloading")
      try { download.progress?.send(progress) } catch (_: Exception) { }
      require(status != DownloadManager.STATUS_FAILED) { "Download failed. Check your connection and available storage, then retry." }
      if (status != DownloadManager.STATUS_SUCCESSFUL) return
      require(total < 0 || total == received) { "The downloaded file is incomplete. Please retry." }
      val receipt = SavedDownload.Managed(download.id, download.name, download.mime)
      receipts[download.id.toString()] = receipt
      clearPendingDownload()
      download.invoke.resolve(JSObject().put("status", "saved").put("id", download.id.toString()).put("name", download.name))
    } catch (error: Exception) {
      clearPendingDownload()
      download.invoke.reject(error.message ?: "Could not complete the download")
    }
  }

  @Command
  fun open_download(invoke: Invoke) = activity.runOnUiThread {
    try {
      val id = invoke.parseArgs(ReceiptArgs::class.java).id
      val receipt = receipts[id] ?: error("Download receipt expired. Open the file from system Downloads.")
      val uri = when (receipt) {
        is SavedDownload.Managed -> {
          val manager = activity.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
          manager.getUriForDownloadedFile(receipt.downloadId) ?: error("The downloaded file was moved or removed")
        }
        is SavedDownload.Local -> Uri.parse(receipt.uri).also {
          activity.contentResolver.openAssetFileDescriptor(it, "r")?.use { }
            ?: error("The downloaded file was moved or removed")
        }
      }
      val open = Intent(Intent.ACTION_VIEW).setDataAndType(uri, receipt.mime)
        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      open.clipData = ClipData.newRawUri(receipt.name, uri)
      activity.startActivity(open)
      invoke.resolve()
    } catch (error: Exception) {
      invoke.reject("Could not open this file. Use Downloads and choose an installed app. " + (error.message ?: ""))
    }
  }

  @Command
  fun reveal_download(invoke: Invoke) = activity.runOnUiThread {
    try {
      val id = invoke.parseArgs(ReceiptArgs::class.java).id
      require(receipts.containsKey(id)) { "Download receipt expired" }
      activity.startActivity(Intent(DownloadManager.ACTION_VIEW_DOWNLOADS))
      invoke.resolve()
    } catch (error: Exception) {
      invoke.reject("Could not open system Downloads. Open the phone's Files app and select Downloads.")
    }
  }

  private fun enqueue(invoke: Invoke, args: DownloadArgs) {
    if (pending != null) {
      invoke.reject("A download is already in progress")
      return
    }
    try {
      history.check(args.requestId)
      val uri = Uri.parse(args.url)
      require(uri.scheme == "https" && uri.host != null && uri.userInfo == null) { "Downloads require an HTTPS URL" }
      val name = safeName(args.name)
      val destination = destinationName(name)
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
      pending = PendingDownload(manager.enqueue(request), destination, args.mime, invoke, args.onProgress, args.requestId)
      handler.post(poll)
    } catch (error: Exception) {
      clearPendingDownload()
      history.record(args.requestId, false)
      invoke.reject(error.message ?: "Download failed")
    }
  }

  private fun safeName(value: String): String {
    val name = value.replace('\\', '/').substringAfterLast('/').replace(Regex("[\\p{Cntrl}<>:\"|?*]"), "_").trim(' ', '.')
    require(name.isNotEmpty()) { "Invalid filename" }
    return name
  }

  private fun destinationName(name: String): String {
    val dot = name.lastIndexOf('.')
    val stem = if (dot > 0) name.substring(0, dot) else name
    val extension = if (dot > 0) name.substring(dot) else ""
    return stem.take(60) + "-" + System.currentTimeMillis() + extension.take(20)
  }

  @android.annotation.TargetApi(29)
  private fun saveLocalImage(invoke: Invoke, args: DownloadArgs) {
    val name = destinationName(safeName(args.name))
    val local = LocalDownload(invoke, args.requestId)
    localPending = local
    try {
      Thread({
        var receipt: SavedDownload.Local? = null
        var failure: String? = null
        try {
          val image = LocalImageData.decode(args.url)
          var lastProgress = 0L
          val saved = local.operation.save(image, {
            MediaStoreImage.create(activity.applicationContext.contentResolver, name, image.mime)
          }) { received, total ->
            val now = SystemClock.elapsedRealtime()
            if (received == 0L || received == total || now - lastProgress >= 100) {
              lastProgress = now
              handler.post {
                if (localPending === local) {
                  try {
                    args.onProgress?.send(JSObject().put("received", received).put("total", total)
                      .put("state", "downloading"))
                  } catch (_: Exception) { }
                }
              }
            }
          }
          receipt = SavedDownload.Local(saved.uri.toString(), name, image.mime)
        } catch (error: Exception) {
          failure = error.message ?: "Could not save local image"
        }
        val saved = receipt
        val error = failure
        handler.post {
          history.record(local.requestId, local.operation.isCancelled())
          localPending = null
          if (saved != null) {
            receipts[saved.id] = saved
            local.invoke.resolve(JSObject().put("status", "saved").put("id", saved.id).put("name", saved.name))
          } else local.invoke.reject(error ?: "Could not save local image")
          for (cancellation in local.cancellations) {
            if (error != null && error != "Download cancelled") cancellation.reject(error)
            else cancellation.resolve()
          }
        }
      }, "baton-local-image").start()
    } catch (error: Exception) {
      localPending = null
      history.record(args.requestId, false)
      throw error
    }
  }
}
