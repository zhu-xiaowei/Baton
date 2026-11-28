package com.batonai.app

import android.os.Bundle
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.activity.SystemBarStyle
import android.app.UiModeManager
import android.content.Context
import android.content.res.Configuration
import android.content.res.Resources
import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import android.graphics.Color
import android.os.Build
import androidx.appcompat.app.AppCompatDelegate
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject

class MainActivity : TauriActivity() {
  private val appearance get() = getSharedPreferences("baton-appearance", Context.MODE_PRIVATE)
  private val preference get() = appearance.getString("preference", null) ?: appearance.getString("mode", "dark") ?: "dark"
  private val resourcesLight get() =
    (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) != Configuration.UI_MODE_NIGHT_YES

  private fun nightMode() = when (preference) {
    "system" -> AppCompatDelegate.MODE_NIGHT_FOLLOW_SYSTEM
    "light" -> AppCompatDelegate.MODE_NIGHT_NO
    else -> AppCompatDelegate.MODE_NIGHT_YES
  }

  // The page reports its resolved colors; on launch they come from the night-mode resources.
  private fun applyAppearance(light: Boolean = resourcesLight, background: Int = getColor(R.color.baton_background)) {
    enableEdgeToEdge(
      statusBarStyle = if (light) SystemBarStyle.light(Color.TRANSPARENT, Color.TRANSPARENT) else SystemBarStyle.dark(Color.TRANSPARENT),
      navigationBarStyle = if (light) SystemBarStyle.light(Color.TRANSPARENT, Color.TRANSPARENT) else SystemBarStyle.dark(Color.TRANSPARENT)
    )
    WindowCompat.getInsetsController(window, window.decorView).apply {
      isAppearanceLightStatusBars = light
      isAppearanceLightNavigationBars = light
    }
    window.decorView.setBackgroundColor(background)
    if (Build.VERSION.SDK_INT >= 29) {
      window.isNavigationBarContrastEnforced = false
      window.isStatusBarContrastEnforced = false
    }
    if (Build.VERSION.SDK_INT >= 31) {
      getSystemService(UiModeManager::class.java).setApplicationNightMode(when (preference) {
        "system" -> UiModeManager.MODE_NIGHT_AUTO
        "light" -> UiModeManager.MODE_NIGHT_NO
        else -> UiModeManager.MODE_NIGHT_YES
      })
    } else {
      AppCompatDelegate.setDefaultNightMode(nightMode())
    }
  }

  // The saved choice, not the resources: before 12 they follow the system, and the window must match the page.
  private val launchLight get() = when (preference) {
    "light" -> true
    "system" -> (Resources.getSystem().configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) != Configuration.UI_MODE_NIGHT_YES
    else -> false
  }
  private val launchCanvas get() = if (launchLight) Color.WHITE else Color.parseColor("#0d1117")
  private var skeleton: View? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    delegate.localNightMode = nightMode()
    super.onCreate(savedInstanceState)
    applyAppearance(launchLight, launchCanvas)
    if (Build.VERSION.SDK_INT >= 31) splashScreen.setOnExitAnimationListener { it.remove() }
    // Three-button navigation draws over the page; gesture navigation has no tappable inset, so the page stays edge to edge.
    ViewCompat.setOnApplyWindowInsetsListener(findViewById(android.R.id.content)) { view, insets ->
      val bar = LaunchSkeletonView.navigationPadding(insets)
      // Before Android 11 an edge-to-edge window is not resized for the keyboard: adjustResize only reports it, with the
      // navigation bar below it, in the system window insets. Later WebViews shrink their own viewport.
      @Suppress("DEPRECATION")
      val keyboard = insets.toWindowInsets()?.systemWindowInsetBottom
        ?.takeIf { Build.VERSION.SDK_INT < 30 && it > insets.getInsets(WindowInsetsCompat.Type.navigationBars()).bottom } ?: 0
      view.setPadding(bar.left, 0, bar.right, maxOf(bar.bottom, keyboard))
      insets
    }
    // Above the content view: Wry replaces the content view when its WebView is ready.
    skeleton = LaunchSkeletonView(this, launchLight).also {
      (window.decorView as ViewGroup).addView(it, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    }
  }

  private fun removeSkeleton() { skeleton?.let { (it.parent as? ViewGroup)?.removeView(it) }; skeleton = null }

  // Like iOS: removed without a fade once the Web skeleton (or any non-home page) has painted. The poll does not
  // wait for each result: a script evaluated during a navigation (index.html → landing.html) may never call back.
  private fun releaseSkeleton(webView: WebView) {
    val started = SystemClock.uptimeMillis()
    webView.post(object : Runnable {
      override fun run() {
        if (skeleton == null) return
        if (SystemClock.uptimeMillis() - started > 15000) return removeSkeleton()
        webView.evaluateJavascript(SKELETON_READY) { if (it == "1") removeSkeleton() }
        webView.postDelayed(this, 20)
      }
    })
  }

  // System Back reaches JS through Tauri's onBackButtonPress; this lets the root page background the app.
  override fun onWebViewCreate(webView: WebView) {
    releaseSkeleton(webView)
    if (WebViewFeature.isFeatureSupported(WebViewFeature.ALGORITHMIC_DARKENING)) {
      WebSettingsCompat.setAlgorithmicDarkeningAllowed(webView.settings, false)
    }
    webView.addJavascriptInterface(object {
      @JavascriptInterface
      fun moveTaskToBack() { runOnUiThread { moveTaskToBack(true) } }
      @JavascriptInterface
      fun getTheme(): String = preference
      @JavascriptInterface
      fun setTheme(value: String) {
        val next = try { JSONObject(value) } catch (_: Exception) { return }
        val mode = next.optString("mode")
        val chosen = next.optString("preference", mode)
        val canvas = next.optString("canvas")
        if (mode !in listOf("light", "dark") || chosen !in listOf("system", "light", "dark") ||
          !canvas.matches(Regex("#[0-9a-fA-F]{6}"))) return
        appearance.edit().putString("mode", mode).putString("preference", chosen).putString("canvas", canvas).apply()
        runOnUiThread {
          delegate.localNightMode = nightMode()
          applyAppearance(mode == "light", Color.parseColor(canvas))
          webView.setBackgroundColor(Color.parseColor(canvas))
        }
      }
    }, "BatonAndroid")
  }

  companion object {
    // index.html sets __skelReady after its skeleton or cached home completes two layouts; other pages only need to load.
    // The WebView starts on about:blank, which is neither.
    private const val SKELETON_READY = "(window.__skelReady||(/^https?:/.test(location.protocol)&&!/(^|\\/)(index\\.html)?\$/.test(location.pathname)&&document.readyState==='complete'))?1:0"
  }
}
