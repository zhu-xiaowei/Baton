package com.batonai.download

internal class RequestHistory(private val now: () -> Long) {
  private data class Entry(val cancelled: Boolean, val at: Long)
  private val entries = linkedMapOf<String, Entry>()

  fun validate(id: String?) {
    require(id == null || id.toByteArray(Charsets.UTF_8).size in 1..128) {
      "requestId must contain 1–128 UTF-8 bytes"
    }
  }

  fun check(id: String?) {
    validate(id)
    prune()
    val entry = entries[id] ?: return
    error(if (entry.cancelled) "Download cancelled" else "requestId has already been used")
  }

  fun record(id: String?, cancelled: Boolean) {
    if (id == null) return
    prune()
    if (!entries.containsKey(id)) entries[id] = Entry(cancelled, now())
    while (entries.size > 256) entries.remove(entries.keys.first())
  }

  private fun prune() {
    val cutoff = now() - 60_000
    entries.entries.removeAll { it.value.at <= cutoff }
  }
}
