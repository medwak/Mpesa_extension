package com.mpesaledger.app;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

// Hands text that was shared to the app (from the Messages app's Share menu)
// to the web app, once.
@CapacitorPlugin(name = "ShareInbox")
public class ShareInboxPlugin extends Plugin {

    static volatile String pending;

    @PluginMethod
    public void take(PluginCall call) {
        JSObject result = new JSObject();
        String text = pending;
        pending = null;
        if (text != null) result.put("text", text);
        call.resolve(result);
    }
}
