package com.batonai.download

import android.Manifest
import android.app.Activity
import android.app.DownloadManager
import android.content.Context
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

  private fun enqueue(invoke: Invoke) {
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
      val result = JSObject()
      result.put("status", "queued")
      result.put("id", manager.enqueue(request))
      invoke.resolve(result)
    } catch (error: Exception) { invoke.reject(error.message ?: "Download failed") }
  }
}
