package com.mpesaledger.app;

import android.content.Intent;
import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(ShareInboxPlugin.class);
        registerPlugin(PrinterPlugin.class);
        super.onCreate(savedInstanceState);
        keepSharedText(getIntent(), false);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        keepSharedText(intent, true);
    }

    // Text shared to the app from Messages ("Share" -> M-Pesa Ledger) is kept
    // until the web app asks for it. If the app is already open, it is told
    // to ask now.
    private void keepSharedText(Intent intent, boolean appIsRunning) {
        if (intent == null || !Intent.ACTION_SEND.equals(intent.getAction())) return;
        CharSequence text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
        if (text == null || text.length() == 0) return;
        ShareInboxPlugin.pending = text.toString();
        if (appIsRunning && getBridge() != null && getBridge().getWebView() != null) {
            getBridge().getWebView().post(() -> getBridge().getWebView()
                .evaluateJavascript("window.mpesaCheckShare && window.mpesaCheckShare();", null));
        }
    }
}
