package com.multizone.desktop

import android.os.Bundle
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.updatePadding

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    // Edge to edge (enforced from target SDK 35), `adjustResize` no longer
    // shrinks the window for the keyboard, so it slid over the composer
    // (0.21). The keyboard's height comes off the bottom of the content
    // instead; the WebView resizes and the page lays out above it. The system
    // bars are left to the page's safe-area padding, as before.
    ViewCompat.setOnApplyWindowInsetsListener(findViewById(android.R.id.content)) { view, insets ->
      view.updatePadding(bottom = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom)
      insets
    }
  }
}
