package com.batonai.push

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.os.Build
import android.webkit.WebView
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
}

@InvokeArg
class ListenArgs {
  lateinit var onClick: Channel
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
    if (Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.GRANTED) {
      requestPermissionForAlias("notifications", invoke, "startAfterPermission")
    } else {
      startService(invoke)
    }
  }

  @PermissionCallback
  private fun startAfterPermission(invoke: Invoke) = startService(invoke)

  private fun startService(invoke: Invoke) {
    if (!NotificationManagerCompat.from(activity).areNotificationsEnabled()) {
      invoke.resolve(JSObject().put("granted", false))
      return
    }
    val args = invoke.parseArgs(StartArgs::class.java)
    AlertService.start(activity, args.server.trimEnd('/'), args.apiKey)
    invoke.resolve(JSObject().put("granted", true))
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
  fun takePending(invoke: Invoke) {
    val events = JSONArray(pending)
    pending.clear()
    invoke.resolve(JSObject().put("events", events))
  }
}
