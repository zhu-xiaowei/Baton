package com.batonai.push

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.webkit.WebView
import androidx.core.app.ActivityCompat
import androidx.core.app.NotificationManagerCompat
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
import org.json.JSONArray

@InvokeArg
class StartArgs {
  lateinit var server: String
  lateinit var apiKey: String
  var prompt: Boolean = true
}

@InvokeArg
class ListenArgs {
  lateinit var onClick: Channel
}

@InvokeArg
class OpenArgs {
  var sessionId: String = ""
}

@TauriPlugin(permissions = [Permission(strings = [Manifest.permission.POST_NOTIFICATIONS], alias = "notifications")])
class PushPlugin(private val activity: Activity) : Plugin(activity) {
  // Taps are kept until JS drains them, so a cold launch cannot lose the destination.
  private val pending = mutableListOf<JSObject>()
  private var onClick: Channel? = null

  override fun load(webView: WebView) {
    AlertService.foreground = true
    takeTap(activity.intent)
  }

  override fun onNewIntent(intent: Intent) = takeTap(intent)

  override fun onResume() { AlertService.foreground = true }

  override fun onPause() { AlertService.foreground = false }

  private fun takeTap(intent: Intent?) {
    val event = intent?.getStringExtra(AlertService.EXTRA_EVENT) ?: return
    intent.removeExtra(AlertService.EXTRA_EVENT)
    pending.add(JSObject(event))
    while (pending.size > 10) pending.removeAt(0)
    onClick?.send(JSObject().put("pending", true))
  }

  @Command
  fun start(invoke: Invoke) {
    val prompt = invoke.parseArgs(StartArgs::class.java).prompt
    if (prompt && Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.GRANTED) {
      requestPermissionForAlias("notifications", invoke, "startAfterPermission")
    } else {
      startService(invoke)
    }
  }

  @PermissionCallback
  private fun startAfterPermission(invoke: Invoke) = startService(invoke)

  private fun startService(invoke: Invoke) {
    if (!NotificationManagerCompat.from(activity).areNotificationsEnabled()) {
      // Blocked: the system will not ask again (or never asks before Android 13); only Settings can allow it.
      val blocked = Build.VERSION.SDK_INT < 33
        || !ActivityCompat.shouldShowRequestPermissionRationale(activity, Manifest.permission.POST_NOTIFICATIONS)
      invoke.resolve(JSObject().put("granted", false).put("blocked", blocked))
      return
    }
    val args = invoke.parseArgs(StartArgs::class.java)
    AlertService.start(activity, args.server.trimEnd('/'), args.apiKey)
    invoke.resolve(JSObject().put("granted", true))
  }

  @Command
  fun openSettings(invoke: Invoke) {
    activity.startActivity(if (Build.VERSION.SDK_INT >= 26) {
      Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, activity.packageName)
    } else {
      Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", activity.packageName, null))
    })
    invoke.resolve()
  }

  @Command
  fun stop(invoke: Invoke) {
    AlertService.stop(activity)
    invoke.resolve()
  }

  @Command
  fun listen(invoke: Invoke) {
    onClick = invoke.parseArgs(ListenArgs::class.java).onClick
    invoke.resolve()
  }

  @Command
  fun setOpen(invoke: Invoke) {
    AlertService.openSession = invoke.parseArgs(OpenArgs::class.java).sessionId
    invoke.resolve()
  }

  @Command
  fun takePending(invoke: Invoke) {
    val events = JSONArray(pending)
    pending.clear()
    invoke.resolve(JSObject().put("events", events))
  }
}
