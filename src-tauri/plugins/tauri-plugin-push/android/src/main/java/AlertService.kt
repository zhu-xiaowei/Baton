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
import android.util.Base64
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

// Polls the account's notification feed from a foreground service, so alerts keep
// arriving while Baton is in the background. WebView timers are throttled there.
// Hosted servers (`relay`) keep no feed: the service holds a `role=notify` socket instead.
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

    fun start(context: Context, server: String, apiKey: String, notifyKey: String, relay: String) {
      prefs(context).edit().putString("server", server).putString("apiKey", apiKey).putString("notifyKey", notifyKey).putString("relay", relay).apply()
      ContextCompat.startForegroundService(context, Intent(context, AlertService::class.java))
    }

    fun stop(context: Context) {
      prefs(context).edit().clear().apply()
      context.stopService(Intent(context, AlertService::class.java))
    }

    // Opening a session clears its stack. A tap cancels only the tapped alert, and a
    // summary left without children would stay in the shade on its own.
    fun clear(context: Context, session: String) {
      val manager = context.getSystemService(NotificationManager::class.java)
      for (sbn in manager.activeNotifications) {
        if (sbn.notification.group == session) manager.cancel(sbn.id)
      }
    }

    private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
  }

  private class StopPolling : Exception()

  @Volatile private var running = false
  private var worker: Thread? = null
  @Volatile private var socket: RelaySocket? = null
  @Volatile private var listening = ""
  private val recent = LinkedHashSet<String>()

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
    // New credentials or relay: reconnect now rather than at the next read timeout.
    if (listening.isNotEmpty() && listening != target()) socket?.close()
    if (worker?.isAlive != true) {
      running = true
      worker = Thread(::poll).apply { isDaemon = true; start() }
    }
    return START_STICKY
  }

  override fun onDestroy() {
    running = false
    worker?.interrupt()
    socket?.close()
    super.onDestroy()
  }

  private fun target() = prefs(this).getString("relay", "") + "|" + prefs(this).getString("apiKey", "")

  private fun poll() {
    var cursor = ""
    var account = ""
    var retry = 0
    while (running) {
      val server = prefs(this).getString("server", null)
      val key = prefs(this).getString("apiKey", null)
      if (server == null || key == null) break
      val relay = prefs(this).getString("relay", null)
      if (!relay.isNullOrEmpty()) {
        try {
          if (listen(relay, key)) retry = 0
        } catch (stop: StopPolling) {
          break
        } catch (_: Exception) {
        }
        // Reconnect: at once after a working socket, then 2, 4 … 60 s, with jitter.
        val wait = if (retry == 0) 0L else minOf(60_000L, 1000L shl minOf(retry, 6))
        retry++
        try {
          Thread.sleep(wait + (Math.random() * 1000).toLong())
        } catch (_: InterruptedException) {
        }
        continue
      }
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

  // Alerts no open app acknowledged, while connected (the server keeps none to replay).
  // Idle 60 s → a text ping; nothing within 10 s → reconnect. True once the socket answered at all.
  private fun listen(relay: String, key: String): Boolean {
    val query = "apiKey=" + URLEncoder.encode(key, "UTF-8") + "&role=notify"
    val ws = RelaySocket("$relay?$query")
    socket = ws
    listening = "$relay|$key"
    var alive = false
    try {
      var pinged = false
      while (running && target() == listening) {
        val text = ws.read(if (pinged) 10_000 else 60_000)
        if (text == null) {
          if (pinged) return alive
          ws.send("{\"action\":\"realtime_ping\"}")
          pinged = true
          continue
        }
        pinged = false
        alive = true
        val event = try { JSONObject(text) } catch (_: Exception) { continue }
        val id = event.optString("eventId")
        if (event.optString("action") != "alert" || id.isEmpty() || !recent.add(id)) continue
        if (recent.size > 50) recent.remove(recent.first())
        show(open(event))
      }
    } catch (closed: RelaySocket.Closed) {
      // Signed out, rotated key, monthly limit, or replaced by another socket with this token.
      if (closed.code == 4401 || closed.code == 4403 || closed.code == 4429 || closed.code == 4409) throw StopPolling()
    } catch (_: java.io.IOException) {
      // Dropped (network change, closed by onStartCommand): reconnect, at once if it had worked.
    } finally {
      listening = ""
      ws.close()
    }
    return alive
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
        for (index in 0 until (events?.length() ?: 0)) show(open(events!!.getJSONObject(index)))
      }
      return body.optString("cursor", cursor)
    } finally {
      connection.disconnect()
    }
  }

  // A sealed alert (`e`, bridge/notify.mjs): AES-GCM, bound to its eventId; plaintext after a 5-byte header.
  private fun open(event: JSONObject): JSONObject {
    val sealed = event.optString("e")
    if (sealed.isEmpty()) return event
    // Not openable here (no key yet): a placeholder; tapping opens it in the app.
    event.put("body", "Open Baton to see this update.")
    val key = prefs(this).getString("notifyKey", null)
    if (key.isNullOrEmpty()) return event
    try {
      val bytes = Base64.decode(sealed, Base64.DEFAULT)
      val cipher = Cipher.getInstance("AES/GCM/NoPadding")
      cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(Base64.decode(key, Base64.DEFAULT), "AES"), GCMParameterSpec(128, bytes, 0, 12))
      cipher.updateAAD(event.optString("eventId").toByteArray())
      val plain = cipher.doFinal(bytes, 12, bytes.size - 12)
      val fields = JSONObject(String(plain, 5, plain.size - 5, Charsets.UTF_8))
      for (name in fields.keys()) event.put(name, fields.get(name))
    } catch (_: Exception) {
    }
    return event
  }

  private fun show(event: JSONObject) {
    // The session already on screen needs no alert.
    if (foreground && openSession.isNotEmpty() && event.optString("rootSessionId") == openSession) return
    val id = event.optString("eventId").hashCode()
    // Every alert stays, stacked per session like the iOS thread.
    val group = event.optString("rootSessionId")
    val summaryId = "group:$group".hashCode()
    val activity = packageManager.getLaunchIntentForPackage(packageName)?.component ?: return
    // Not the launcher intent: that one only brings a running task to front and drops extras.
    val tap = Intent(ACTION_OPEN).setComponent(activity)
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
      .putExtra(EXTRA_EVENT, event.toString())
    val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    val builder = { requestCode: Int ->
      NotificationCompat.Builder(this, ALERT_CHANNEL)
        .setSmallIcon(R.drawable.ic_push)
        .setSubText(event.optString("projectName"))
        .setContentTitle(event.optString("sessionTitle").ifEmpty { event.optString("title") })
        .setGroup(group)
        .setAutoCancel(true)
        .setContentIntent(PendingIntent.getActivity(this, requestCode, tap, flags))
    }
    val notification = builder(id)
      .setContentText(event.optString("body"))
      .setStyle(NotificationCompat.BigTextStyle().bigText(event.optString("body")))
      .setPriority(NotificationCompat.PRIORITY_HIGH)
      .build()
    // The summary only holds the stack; the alert comes from the new child.
    val summary = builder(summaryId)
      .setGroupSummary(true)
      .setGroupAlertBehavior(NotificationCompat.GROUP_ALERT_CHILDREN)
      .build()
    try {
      NotificationManagerCompat.from(this).notify(id, notification)
      NotificationManagerCompat.from(this).notify(summaryId, summary)
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
