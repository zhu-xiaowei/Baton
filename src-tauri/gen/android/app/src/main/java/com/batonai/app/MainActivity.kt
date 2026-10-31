package com.batonai.app

import android.os.Bundle
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.activity.SystemBarStyle
import android.app.UiModeManager
import android.content.Context
import android.graphics.Color
import android.os.Build
import androidx.appcompat.app.AppCompatDelegate
import androidx.core.view.WindowCompat
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject

class MainActivity : TauriActivity() {
  private val appearance get() = getSharedPreferences("baton-appearance", Context.MODE_PRIVATE)

  private fun applyAppearance() {
    val light = appearance.getString("mode", "dark") == "light"
    val background = Color.parseColor(appearance.getString("canvas", "#0d1117"))
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
      getSystemService(UiModeManager::class.java).setApplicationNightMode(
        if (light) UiModeManager.MODE_NIGHT_NO else UiModeManager.MODE_NIGHT_YES
      )
    } else {
      AppCompatDelegate.setDefaultNightMode(
        if (light) AppCompatDelegate.MODE_NIGHT_NO else AppCompatDelegate.MODE_NIGHT_YES
      )
    }
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    delegate.localNightMode = if (appearance.getString("mode", "dark") == "light")
      AppCompatDelegate.MODE_NIGHT_NO else AppCompatDelegate.MODE_NIGHT_YES
    super.onCreate(savedInstanceState)
    applyAppearance()
  }

  // System Back reaches JS through Tauri's onBackButtonPress; this lets the root page background the app.
  override fun onWebViewCreate(webView: WebView) {
    webView.setBackgroundColor(Color.parseColor(appearance.getString("canvas", "#0d1117")))
    if (WebViewFeature.isFeatureSupported(WebViewFeature.ALGORITHMIC_DARKENING)) {
      WebSettingsCompat.setAlgorithmicDarkeningAllowed(webView.settings, false)
    }
    webView.addJavascriptInterface(object {
      @JavascriptInterface
      fun moveTaskToBack() { runOnUiThread { moveTaskToBack(true) } }
      @JavascriptInterface
      fun getTheme(): String = appearance.getString("mode", "dark") ?: "dark"
      @JavascriptInterface
      fun setTheme(value: String) {
        val next = try { JSONObject(value) } catch (_: Exception) { return }
        val mode = next.optString("mode")
        val canvas = next.optString("canvas")
        if (mode !in listOf("light", "dark") || !canvas.matches(Regex("#[0-9a-fA-F]{6}"))) return
        appearance.edit().putString("mode", mode).putString("canvas", canvas).apply()
        runOnUiThread {
          delegate.localNightMode = if (mode == "light") AppCompatDelegate.MODE_NIGHT_NO else AppCompatDelegate.MODE_NIGHT_YES
          applyAppearance()
          webView.setBackgroundColor(Color.parseColor(canvas))
        }
      }
    }, "BatonAndroid")
  }
}
