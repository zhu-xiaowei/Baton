package com.batonai.app

import android.content.Context
import android.graphics.Canvas
import android.graphics.LinearGradient
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.graphics.Shader
import android.graphics.Typeface
import android.os.Build
import android.view.View
import androidx.core.graphics.Insets
import androidx.core.graphics.PathParser
import androidx.core.view.WindowInsetsCompat
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.max

// Draws the home page's Web skeleton (index.html renderSkeleton) natively, in CSS px == dp, so removing it
// once the WebView reports window.__skelReady shows the same pixels.
class LaunchSkeletonView(context: Context, light: Boolean) : View(context) {
  private class Palette(val canvas: Int, val elevated: Int, val raised: Int, val border: Int, val header: Int,
    val divider: Int, val accent: Int, val text: Int, val muted: Int, val logo: Int, val cardEnd: Int)

  private val c = if (light) Palette(0xffffffff.toInt(), 0xfff6f8fa.toInt(), 0xffeaeef2.toInt(), 0xffd0d7de.toInt(),
    0xffeaeef2.toInt(), 0xffd8dee4.toInt(), 0xff0969da.toInt(), 0xff1f2328.toInt(), 0xff818b98.toInt(), 0xff171a20.toInt(), 0xfff6f8fa.toInt())
  else Palette(0xff0d1117.toInt(), 0xff161b22.toInt(), 0xff21262d.toInt(), 0xff30363d.toInt(),
    0xff21262d.toInt(), 0xff21262d.toInt(), 0xff58a6ff.toInt(), 0xffe6edf3.toInt(), 0xff6e7681.toInt(), 0xffe6edf3.toInt(), 0xff1c2128.toInt())

  private val d = resources.displayMetrics.density
  private val fill = Paint(Paint.ANTI_ALIAS_FLAG)
  private val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND }
  // Chrome on Android draws text unhinted at subpixel positions.
  private val text = Paint(Paint.ANTI_ALIAS_FLAG or Paint.SUBPIXEL_TEXT_FLAG or Paint.LINEAR_TEXT_FLAG)
  // Chrome maps weight 600 to Bold on static Roboto and to wght 600 on the variable Roboto of Android 12+.
  private val semibold = if (Build.VERSION.SDK_INT >= 28) Typeface.create(Typeface.SANS_SERIF, if (Build.VERSION.SDK_INT >= 31) 600 else 700, false)
    else Typeface.create(Typeface.SANS_SERIF, Typeface.BOLD)
  private val logo = Path().apply {
    LOGO.forEach { addPath(PathParser.createPathFromPathData(it)) }
    transform(Matrix().apply { setTranslate(2f, -147f) })
  }
  private val gear = Path().apply {
    addPath(PathParser.createPathFromPathData(GEAR))
    addCircle(12f, 12f, 3f, Path.Direction.CW)
  }

  init { setBackgroundColor(c.canvas) }

  private fun px(v: Float) = v * d
  // CSS borders snap to whole device pixels; Chrome keeps at least one.
  private val hair = max(1f, floor(d)) / d

  private fun rect(cv: Canvas, color: Int, x: Float, y: Float, w: Float, h: Float, r: Float = 0f) {
    fill.color = color
    if (r > 0) cv.drawRoundRect(RectF(px(x), px(y), px(x + w), px(y + h)), px(r), px(r), fill)
    else cv.drawRect(px(x), px(y), px(x + w), px(y + h), fill)
  }

  // An active card's background is linear-gradient(135deg, surface-elevated, card-gradient-end) over its border box.
  private fun frame(cv: Canvas, x: Float, y: Float, w: Float, h: Float, card: Boolean = false) {
    rect(cv, c.border, x, y, w, h, 8f)
    if (card) {
      val half = (w + h) * 0.35355f
      fill.shader = LinearGradient(px(x + w / 2 - half), px(y + h / 2 - half), px(x + w / 2 + half), px(y + h / 2 + half),
        c.elevated, c.cardEnd, Shader.TileMode.CLAMP)
    }
    rect(cv, c.canvas, x + hair, y + hair, w - 2 * hair, h - 2 * hair, 8f - hair)
    fill.shader = null
  }

  // CSS line-height normal: the font's ascent + descent; the baseline sits at top + ascent.
  private fun line(size: Float): Pair<Float, Float> {
    text.typeface = semibold; text.textSize = px(size)
    val m = text.fontMetrics
    return Pair((m.descent - m.ascent) / d, -m.ascent / d)
  }

  private fun label(cv: Canvas, s: String, x: Float, top: Float, size: Float, color: Int, lineHeight: Float? = null) {
    val (normal, ascent) = line(size)
    val lh = lineHeight ?: normal
    text.color = color
    // Chrome rounds the baseline to a whole device pixel.
    cv.drawText(s, px(x), Math.round(px(top + (lh - normal) / 2 + ascent)).toFloat(), text)
  }

  override fun onDraw(cv: Canvas) {
    val insets = rootWindowInsets?.let { WindowInsetsCompat.toWindowInsetsCompat(it, this) }
      ?.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
    // WebView rounds env(safe-area-inset-top) up to whole CSS px.
    val sat = ceil((insets?.top ?: 0) / d)
    // The content view is padded clear of three-button navigation (MainActivity); draw inside the same area.
    val side = rootWindowInsets?.let { navigationPadding(WindowInsetsCompat.toWindowInsetsCompat(it, this)) }
    cv.translate((side?.left ?: 0).toFloat(), 0f)
    val vw = (width - (side?.left ?: 0) - (side?.right ?: 0)) / d
    // The skeleton is the phone portrait layout (max-width: 480px); landscape and wide layouts differ, so they get the canvas only.
    if (vw > 480f || width > height) return
    // Top bar: surface, 44px row under the status bar, 1px inset shadow at the bottom.
    val bar = sat + 44f
    rect(cv, c.elevated, 0f, 0f, vw, bar)
    rect(cv, c.border, 0f, bar - 1f, vw, 1f)
    cv.save()
    cv.translate(px(12f), px(sat + 11.5f + 0.5f))
    cv.scale(px(20f) / 720f, px(20f) / 720f)
    fill.color = c.logo
    cv.drawPath(logo, fill)
    cv.restore()
    label(cv, "Baton", 38f, sat + 11.5f, 17f, c.text, 21f)
    cv.save()
    cv.translate(px(vw - 8f - 33f), px(sat + 11f))
    cv.scale(px(22f) / 24f, px(22f) / 24f)
    stroke.color = c.muted; stroke.strokeWidth = 2f
    cv.drawPath(gear, stroke)
    cv.restore()

    // #content's scrollbar-gutter: stable reserves 6 CSS px, snapped down to device pixels.
    val cw = vw - floor(6f * d) / d
    var y = bar
    val (l14, _) = line(14f)
    label(cv, "ACTIVE SESSIONS", 12f, y + 16f, 14f, c.accent)
    y += 16f + l14 + 12f
    val cardW = cw - 16f
    val inner = cardW - 2 * hair - 24f
    repeat(2) {
      frame(cv, 8f, y, cardW, 2 * hair + 24f + 21f + 6f + 22f + 6f + 18f, card = true)
      val x0 = 8f + hair + 12f
      var r = y + hair + 12f
      rect(cv, c.raised, x0, r + 4.5f, inner * 0.4f, 12f, 4f)
      rect(cv, c.raised, x0 + inner * 0.84f, r + 4.5f, inner * 0.16f, 12f, 4f)
      r += 21f + 6f
      rect(cv, c.raised, x0, r + 4f, inner * 0.8f, 14f, 4f)
      r += 22f + 6f
      rect(cv, c.raised, x0, r + 3f, inner * 0.24f, 12f, 4f)
      rect(cv, c.raised, x0 + inner * 0.84f, r + 3f, inner * 0.16f, 12f, 4f)
      y += 2 * hair + 24f + 21f + 6f + 22f + 6f + 18f + 8f
    }
    label(cv, "RECENT PROJECTS", 12f, y + 8f, 14f, c.accent)
    y += 8f + l14 + 12f
    val listH = 2 * hair + 44f * 6
    frame(cv, 8f, y, cardW, listH)
    val left = 8f + hair
    val rowW = cardW - 2 * hair
    cv.save()
    val clip = Path().apply { addRoundRect(RectF(px(left), px(y + hair), px(left + rowW), px(y + listH - hair)), px(8f - hair), px(8f - hair), Path.Direction.CW) }
    cv.clipPath(clip)
    rect(cv, c.header, left, y + hair, rowW, 44f)
    rect(cv, c.raised, left + 12f, y + hair + 16f, (rowW - 24f) * 0.4f, 12f, 4f)
    var row = y + hair + 44f
    for (w in floatArrayOf(0.6f, 0.4f, 0.8f, 0.6f, 0.4f)) {
      rect(cv, c.divider, left, row, rowW, hair)
      rect(cv, c.raised, left + 12f, row + hair + (44f - hair - 12f) / 2, (rowW - 68f) * w, 12f, 4f)
      row += 44f
    }
    cv.restore()
  }

  companion object {
    // Tappable insets are zero for gesture navigation; before Android 10 they fall back to the system window insets,
    // which include the keyboard, so they are capped by the navigation bar.
    fun navigationPadding(insets: WindowInsetsCompat): Insets =
      Insets.min(insets.getInsets(WindowInsetsCompat.Type.tappableElement()), insets.getInsets(WindowInsetsCompat.Type.navigationBars()))
    private val LOGO = arrayOf(
      "M535.83872 744.22272A81.92 81.92 0 0 0 634.88 664.10496v-320.1024a81.92 81.92 0 0 0-61.56288-79.36l-143.36-36.7616C378.12224 214.6304 327.68 253.7472 327.68 307.24096v116.5312a20.48 20.48 0 1 0 40.96 0v-116.5312a40.96 40.96 0 0 1 51.13856-39.66976l143.36 36.7616A40.96 40.96 0 0 1 593.92 344.00256v320.1024a40.96 40.96 0 0 1-49.52064 40.05888l-85.46304-18.26816a20.48 20.48 0 0 0-8.56064 40.05888l85.46304 18.26816zM180.96128 285.34784A81.92 81.92 0 0 0 81.92 365.4656v320.1024a81.92 81.92 0 0 0 61.56288 79.33952l143.36 36.7616c51.8144 13.29152 102.27712-25.84576 102.27712-79.33952V628.5312a20.48 20.48 0 1 0-40.96 0v93.77792a40.96 40.96 0 0 1-51.13856 39.66976l-143.36-36.7616A40.96 40.96 0 0 1 122.88 685.568v-320.1024a40.96 40.96 0 0 1 49.52064-40.05888l85.46304 18.24768a20.48 20.48 0 0 0 8.56064-40.05888l-85.46304-18.24768z",
      "M272.708 610.145 488.708 423.145A24 24 0 0 0 457.292 386.855L241.292 573.855A24 24 0 0 0 272.708 610.145Z")
    private const val GEAR = "M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"
  }
}
