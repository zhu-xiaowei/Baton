package com.batonai.download

import java.util.Base64

data class LocalImageData(val mime: String, val bytes: ByteArray) {
  companion object {
    const val MAX_BYTES = 32 * 1024 * 1024
    fun decode(url: String): LocalImageData {
      val comma = url.indexOf(',')
      require(comma in 1..63) { "Invalid image data URL" }
      val header = url.substring(0, comma)
      require(header.startsWith("data:") && header.endsWith(";base64")) { "Invalid image data URL" }
      val mime = header.removePrefix("data:").removeSuffix(";base64")
      require(mime in setOf("image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml")) {
        "Unsupported image MIME type"
      }
      val encoded = url.substring(comma + 1)
      require(encoded.length <= (MAX_BYTES + 2) / 3 * 4) { "Image exceeds 32 MiB" }
      val bytes = Base64.getDecoder().decode(encoded)
      require(bytes.isNotEmpty() && bytes.size <= MAX_BYTES) { "Image must contain 1 byte to 32 MiB" }
      require(Base64.getEncoder().encodeToString(bytes) == encoded) { "Invalid base64 image" }
      return LocalImageData(mime, bytes)
    }
  }
}
