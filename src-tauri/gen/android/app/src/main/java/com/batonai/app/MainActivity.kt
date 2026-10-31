package com.batonai.app

import android.os.Bundle
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.activity.SystemBarStyle
import android.app.UiModeManager
import android.content.Context
import android.content.res.Configuration
import android.graphics.Color
import android.os.Build
import androidx.appcompat.app.AppCompatDelegate
import androidx.core.view.WindowCompat
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

  override fun onCreate(savedInstanceState: Bundle?) {
    delegate.localNightMode = nightMode()
    super.onCreate(savedInstanceState)
    applyAppearance()
  }

  // System Back reaches JS through Tauri's onBackButtonPress; this lets the root page background the app.
  override fun onWebViewCreate(webView: WebView) {
    webView.setBackgroundColor(getColor(R.color.baton_background))
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
}
