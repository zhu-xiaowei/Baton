package com.batonai.push

import android.util.Base64
import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.io.DataInputStream
import java.io.IOException
import java.net.InetSocketAddress
import java.net.Socket
import java.net.SocketTimeoutException
import java.net.URI
import java.security.SecureRandom
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLSocket
import javax.net.ssl.SSLSocketFactory

// A minimal RFC 6455 client for the relay's notify socket (no third-party library): TLS, one upgrade,
// masked frames out, unfragmented text, ping and close in. One thread reads; `close()` may come from another.
class RelaySocket(url: String) {
  class Closed(val code: Int) : IOException("closed with $code")

  private val random = SecureRandom()
  private val socket: SSLSocket
  private lateinit var input: DataInputStream

  init {
    val uri = URI(url)
    val port = if (uri.port > 0) uri.port else 443
    val raw = Socket().apply { connect(InetSocketAddress(uri.host, port), 10_000) }
    socket = (SSLSocketFactory.getDefault() as SSLSocketFactory).createSocket(raw, uri.host, port, true) as SSLSocket
    try {
      socket.soTimeout = 10_000
      socket.startHandshake()
      if (!HttpsURLConnection.getDefaultHostnameVerifier().verify(uri.host, socket.session)) throw IOException("certificate does not match ${uri.host}")
      input = DataInputStream(BufferedInputStream(socket.inputStream))
      val key = Base64.encodeToString(ByteArray(16).also(random::nextBytes), Base64.NO_WRAP)
      socket.outputStream.write(("GET ${uri.rawPath}?${uri.rawQuery} HTTP/1.1\r\nHost: ${uri.host}\r\nUpgrade: websocket\r\n" +
        "Connection: Upgrade\r\nSec-WebSocket-Key: $key\r\nSec-WebSocket-Version: 13\r\n\r\n").toByteArray())
      val status = line()
      while (line().isNotEmpty()) {}
      if (!status.startsWith("HTTP/1.1 101")) throw IOException(status)
    } catch (error: Exception) {
      close()
      throw error
    }
  }

  private fun line(): String {
    val out = StringBuilder()
    while (true) {
      val c = input.read()
      if (c < 0) throw Closed(1006)
      if (c == '\n'.code) return out.toString().trimEnd('\r')
      out.append(c.toChar())
    }
  }

  fun send(text: String) = write(0x1, text.toByteArray())

  @Synchronized private fun write(opcode: Int, payload: ByteArray) {
    val mask = ByteArray(4).also(random::nextBytes)
    val frame = ByteArrayOutputStream()
    frame.write(0x80 or opcode)
    when {
      payload.size < 126 -> frame.write(0x80 or payload.size)
      payload.size < 65536 -> { frame.write(0x80 or 126); frame.write(payload.size shr 8); frame.write(payload.size and 0xff) }
      else -> { frame.write(0x80 or 127); for (i in 7 downTo 0) frame.write(((payload.size.toLong() shr (8 * i)) and 0xff).toInt()) }
    }
    frame.write(mask, 0, 4)
    for (i in payload.indices) frame.write(payload[i].toInt() xor mask[i % 4].toInt())
    socket.outputStream.write(frame.toByteArray())
    socket.outputStream.flush()
  }

  // The next text message ("" for any other frame); null when nothing arrived within `timeoutMs`.
  fun read(timeoutMs: Int): String? {
    socket.soTimeout = timeoutMs
    val first = try { input.read() } catch (_: SocketTimeoutException) { return null }
    if (first < 0) throw Closed(1006)
    socket.soTimeout = 10_000
    val second = input.readUnsignedByte()
    var length = (second and 0x7f).toLong()
    if (length == 126L) length = input.readUnsignedShort().toLong() else if (length == 127L) length = input.readLong()
    if (length < 0 || length > (1L shl 20)) throw IOException("frame of $length bytes")
    val mask = if (second and 0x80 != 0) ByteArray(4).also { input.readFully(it) } else null
    val payload = ByteArray(length.toInt()).also { input.readFully(it) }
    if (mask != null) for (i in payload.indices) payload[i] = (payload[i].toInt() xor mask[i % 4].toInt()).toByte()
    return when (first and 0x0f) {
      0x1 -> String(payload, Charsets.UTF_8)
      0x8 -> throw Closed(if (payload.size >= 2) ((payload[0].toInt() and 0xff) shl 8) or (payload[1].toInt() and 0xff) else 1005)
      0x9 -> { write(0xA, payload); "" }
      else -> ""
    }
  }

  fun close() {
    try { socket.close() } catch (_: Exception) {}
  }
}
