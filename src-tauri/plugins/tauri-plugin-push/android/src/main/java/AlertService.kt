package com.batonai.push

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

// Polls the account's notification feed from a foreground service, so alerts keep
// arriving while Baton is in the background. WebView timers are throttled there.
class AlertService : Service() {
  companion object {
    const val EXTRA_EVENT = "com.batonai.push.EVENT"
    private const val ACTION_OPEN = "com.batonai.push.OPEN"
    private const val PREFS = "baton-push"
    private const val STATUS_CHANNEL = "background"
    private const val ALERT_CHANNEL = "session-updates"
    private const val STATUS_ID = 1

    @Volatile var foreground = false
    @Volatile var openSession = ""

    fun start(context: Context, server: String, apiKey: String) {
      prefs(context).edit().putString("server", server).putString("apiKey", apiKey).apply()
      ContextCompat.startForegroundService(context, Intent(context, AlertService::class.java))
    }

    fun stop(context: Context) {
      prefs(context).edit().clear().apply()
      context.stopService(Intent(context, AlertService::class.java))
    }

    private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
  }

  private class StopPolling : Exception()

  @Volatile private var running = false
  private var worker: Thread? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (prefs(this).getString("apiKey", null) == null) {
      stopSelf()
      return START_NOT_STICKY
    }
    createChannels()
    try {
      if (Build.VERSION.SDK_INT >= 34) {
        startForeground(STATUS_ID, statusNotification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
      } else {
        startForeground(STATUS_ID, statusNotification())
      }
    } catch (error: Exception) {
      // Android 12+ refuses some background restarts; the app restarts it when opened.
      stopSelf()
      return START_NOT_STICKY
    }
    if (worker?.isAlive != true) {
      running = true
      worker = Thread(::poll).apply { isDaemon = true; start() }
    }
    return START_STICKY
  }

  override fun onDestroy() {
    running = false
    worker?.interrupt()
    super.onDestroy()
  }

  private fun poll() {
    var cursor = ""
    var account = ""
    while (running) {
      val server = prefs(this).getString("server", null)
      val key = prefs(this).getString("apiKey", null)
      if (server == null || key == null) break
      if (key != account) {
        account = key
        cursor = ""  // A new sign-in starts a fresh baseline.
      }
      try {
        cursor = fetch(server, key, cursor)
      } catch (stop: StopPolling) {
        break
      } catch (_: Exception) {
        // Offline or a server error: retry on the next tick.
      }
      try {
        Thread.sleep(if (foreground) 5_000L else 15_000L)
      } catch (_: InterruptedException) {
      }
    }
    if (running) stopSelf()
  }

  // The first request (no cursor) only returns a baseline, so nothing is replayed.
  private fun fetch(server: String, key: String, cursor: String): String {
    val query = if (cursor.isEmpty()) "" else "?cursor=" + URLEncoder.encode(cursor, "UTF-8")
    val connection = URL("$server/api/notifications/events$query").openConnection() as HttpURLConnection
    connection.connectTimeout = 10_000
    connection.readTimeout = 10_000
    connection.setRequestProperty("x-api-key", key)
    try {
      when (connection.responseCode) {
        200 -> {}
        401, 403, 404 -> throw StopPolling()  // Signed out, rotated key, or a server without notifications.
        else -> return cursor
      }
      val body = JSONObject(connection.inputStream.bufferedReader().use { it.readText() })
      if (cursor.isNotEmpty()) {
        val events = body.optJSONArray("events")
        for (index in 0 until (events?.length() ?: 0)) show(events!!.getJSONObject(index))
      }
      return body.optString("cursor", cursor)
    } finally {
      connection.disconnect()
    }
  }

  private fun show(event: JSONObject) {
    // The session already on screen needs no alert.
    if (foreground && openSession.isNotEmpty() && event.optString("rootSessionId") == openSession) return
    val id = event.optString("eventId").hashCode()
    val activity = packageManager.getLaunchIntentForPackage(packageName)?.component ?: return
    // Not the launcher intent: that one only brings a running task to front and drops extras.
    val tap = Intent(ACTION_OPEN).setComponent(activity)
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
      .putExtra(EXTRA_EVENT, event.toString())
    val notification = NotificationCompat.Builder(this, ALERT_CHANNEL)
      .setSmallIcon(R.drawable.ic_push)
      .setContentTitle(event.optString("title"))
      .setContentText(event.optString("body"))
      .setStyle(NotificationCompat.BigTextStyle().bigText(event.optString("body")))
      .setPriority(NotificationCompat.PRIORITY_HIGH)
      .setAutoCancel(true)
      .setContentIntent(PendingIntent.getActivity(this, id, tap,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))
      .build()
    try {
      NotificationManagerCompat.from(this).notify(id, notification)
    } catch (_: SecurityException) {
      // Notification permission was revoked in system settings.
    }
  }

  private fun statusNotification(): Notification {
    val open = packageManager.getLaunchIntentForPackage(packageName)
    return NotificationCompat.Builder(this, STATUS_CHANNEL)
      .setSmallIcon(R.drawable.ic_push)
      .setContentTitle(getString(R.string.push_running))
      .setPriority(NotificationCompat.PRIORITY_MIN)
      .setOngoing(true)
      .setContentIntent(open?.let { PendingIntent.getActivity(this, 0, it, PendingIntent.FLAG_IMMUTABLE) })
      .build()
  }

  private fun createChannels() {
    if (Build.VERSION.SDK_INT < 26) return
    val manager = getSystemService(NotificationManager::class.java)
    manager.createNotificationChannel(NotificationChannel(
      STATUS_CHANNEL, getString(R.string.push_status_channel), NotificationManager.IMPORTANCE_MIN))
    manager.createNotificationChannel(NotificationChannel(
      ALERT_CHANNEL, getString(R.string.push_alert_channel), NotificationManager.IMPORTANCE_HIGH))
  }
}
