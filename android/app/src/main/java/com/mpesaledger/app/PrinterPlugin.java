package com.mpesaledger.app;

import android.content.Context;
import android.print.PrintAttributes;
import android.print.PrintDocumentAdapter;
import android.print.PrintManager;
import android.webkit.WebView;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

// Opens Android's print screen for the current page, where "Save as PDF" is
// one of the printers. The page's print styles show only the statement.
@CapacitorPlugin(name = "Printer")
public class PrinterPlugin extends Plugin {

    @PluginMethod
    public void print(PluginCall call) {
        String name = call.getString("name", "M-Pesa statement");
        getActivity().runOnUiThread(() -> {
            PrintManager manager = (PrintManager) getActivity().getSystemService(Context.PRINT_SERVICE);
            WebView webView = getBridge().getWebView();
            PrintDocumentAdapter adapter = webView.createPrintDocumentAdapter(name);
            manager.print(name, adapter, new PrintAttributes.Builder().build());
            call.resolve();
        });
    }
}
