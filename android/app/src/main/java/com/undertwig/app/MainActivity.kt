package com.undertwig.app

import android.os.Bundle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.appcompat.app.AppCompatActivity
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Surface
import androidx.compose.ui.Modifier
import com.undertwig.app.ui.UndertwigApp
import com.undertwig.app.ui.UndertwigViewModel
import com.undertwig.app.ui.theme.UndertwigTheme

class MainActivity : AppCompatActivity() {
    private val viewModel: UndertwigViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        viewModel.attachEngine(this)
        enableEdgeToEdge()
        setContent {
            UndertwigTheme {
                Surface(modifier = Modifier.fillMaxSize()) {
                    UndertwigApp(viewModel = viewModel)
                }
            }
        }
    }
}
