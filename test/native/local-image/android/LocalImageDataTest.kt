package com.batonai.download

import org.junit.Assert.*
import org.junit.Test
import java.util.Base64

class LocalImageDataTest {
  @Test fun preservesOriginalUtf8Bytes() {
    val original = "<svg><text>中文 &amp; café</text></svg>".toByteArray(Charsets.UTF_8)
    val result = LocalImageData.decode("data:image/svg+xml;base64," + Base64.getEncoder().encodeToString(original))
    assertEquals("image/svg+xml", result.mime)
    assertArrayEquals(original, result.bytes)
  }

  @Test fun rejectsOtherSchemesMimeTypesAndNonCanonicalBase64() {
    for (value in listOf("file:///tmp/x", "data:text/html;base64,YQ==", "data:image/png;base64,",
      "data:image/png;base64,YQ", "data:image/png;base64,YR==", "data:image/png;base64,@@@=")) {
      try { LocalImageData.decode(value); fail("Accepted $value") }
      catch (_: IllegalArgumentException) {}
    }
  }

  @Test fun boundsDecodedAndEncodedSize() {
    val bytes = ByteArray(LocalImageData.MAX_BYTES) { 42 }
    val value = "data:image/png;base64," + Base64.getEncoder().encodeToString(bytes)
    assertArrayEquals(bytes, LocalImageData.decode(value).bytes)
    val oversized = "data:image/png;base64," + "A".repeat((LocalImageData.MAX_BYTES + 2) / 3 * 4 + 4)
    try { LocalImageData.decode(oversized); fail("Accepted oversized image") }
    catch (_: IllegalArgumentException) {}
  }
}
