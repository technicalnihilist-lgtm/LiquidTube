package com.liquidtube.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ComponentCallbacks2;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.HashMap;
import java.util.Map;

public class MainActivity extends Activity {

    /** Virtual origin so the page runs in a proper secure https context (CORS + localStorage). */
    private static final String HOST = "liquidtube.local";

    /**
     * Only these hosts may be contacted. Everything else is refused inside the WebView, so the
     * app cannot be turned into a pipe for trackers, ads or arbitrary traffic.
     */
    private static final String[] ALLOWED_HOSTS = {
            "googleapis.com", "gstatic.com", "googleusercontent.com", "ggpht.com",
            "ytimg.com", "youtube.com", "youtube-nocookie.com", "googlevideo.com",
            "youtu.be", "google.com"
    };
    private static final String START_URL = "https://" + HOST + "/index.html";

    /**
     * Debug mode is a parameter, not a build: the page turns its boot self-check on when
     * it sees this, and nothing else about the page changes. It is never in START_URL, so
     * a normal launch never carries it, and the only way to ask for it is an intent extra
     * on a launch a developer started by hand:
     *
     *   adb shell am start -n com.liquidtube.app/.MainActivity --ez ltdebug true
     */
    private static final String EXTRA_DEBUG = "ltdebug";
    private static final String DEBUG_URL = START_URL + "?ltdebug=1";

    /** Logcat tag, and the only console prefix that is forwarded to it. */
    private static final String TAG = "LiquidTube";
    private static final String LOG_PREFIX = "lt-";

    private static final String BACK_JS =
            "(function(){"
            + "var m=document.getElementById('md');"
            + "if(m&&m.classList.contains('on')){m.classList.remove('on');return 'dialog';}"
            + "var p=document.getElementById('pl');"
            + "if(p&&p.classList.contains('on')){var c=document.getElementById('cl');"
            + "if(c){c.click();return 'player';}}"
            + "return 'none';})()";

    /**
     * Item 8.10: the player is given back when the app goes to the background and rebuilt when it
     * comes back. {@code onPause}/{@code onResume} are the signals a WebView actually guarantees,
     * so the page is driven from here instead of being left to {@code visibilitychange} alone; the
     * page's own listener is the fallback and both sides are idempotent, so the two paths can
     * neither free twice nor restore twice. Every call is guarded and swallows its own failure:
     * a page that is not ready simply answers '0'.
     */
    private static final String BG_FREE_JS =
            "(function(){try{return window.__ltBgFree&&window.__ltBgFree(1)?'1':'0'}catch(e){return '0'}})()";
    private static final String BG_RESTORE_JS =
            "(function(){try{return window.__ltBgRestore&&window.__ltBgRestore(1)?'1':'0'}catch(e){return '0'}})()";
    /**
     * Fullscreen hides the WebView while the app is still in front, so the document reports itself
     * hidden with the video the user is watching on screen. The page refuses to free the player
     * while this flag is up; it is raised before the WebView is hidden and lowered on the way out.
     */
    private static final String FS_JS =
            "(function(){try{if(window.__ltFs)window.__ltFs(1)}catch(e){}})()";
    private static final String UNFS_JS =
            "(function(){try{if(window.__ltFs)window.__ltFs(0)}catch(e){}})()";

    private FrameLayout root;
    private WebView web;
    private View customView;
    private FrameLayout fullscreenHolder;
    private WebChromeClient.CustomViewCallback customViewCallback;
    /**
     * The decor view's system-UI flags as they were before the player took the screen,
     * or -1 when nothing is fullscreen. Exiting puts these back instead of forcing
     * {@code SYSTEM_UI_FLAG_VISIBLE}, so the window is left the way it was found.
     */
    private int preFullscreenUiFlags = -1;
    private Chrome chrome;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);

        getWindow().setFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON,
                WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        root = new FrameLayout(this);
        root.setBackgroundColor(Color.parseColor("#0A0A14"));

        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#0A0A14"));
        root.addView(web, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setSupportZoom(false);
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        s.setSupportMultipleWindows(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setSaveFormData(false);
        s.setGeolocationEnabled(false);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        }
        // YouTube embeds behave better when the WebView does not announce itself as a wv client.
        String ua = s.getUserAgentString();
        if (ua != null) {
            s.setUserAgentString(ua.replace("; wv", "").replace("Version/4.0 ", ""));
        }

        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (uri == null) {
                    return null;
                }
                String reqHost = uri.getHost();
                if (!HOST.equals(reqHost)) {
                    // anything outside the allowlist never leaves the device
                    return hostAllowed(reqHost) ? null : blocked("Blocked by allowlist");
                }
                String path = uri.getPath();
                if (path == null || path.isEmpty() || "/".equals(path)) {
                    path = "/index.html";
                }
                try {
                    InputStream in = getAssets().open(path.substring(1));
                    Map<String, String> headers = new HashMap<>();
                    headers.put("Access-Control-Allow-Origin", "*");
                    headers.put("Cache-Control", "no-cache");
                    return new WebResourceResponse(mimeOf(path), "utf-8", 200, "OK", headers, in);
                } catch (IOException e) {
                    return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found",
                            new HashMap<String, String>(), new ByteArrayInputStream(new byte[0]));
                }
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (uri == null) {
                    return false;
                }
                if (HOST.equals(uri.getHost())) {
                    return false;
                }
                openExternally(uri);
                return true;
            }
        });

        chrome = new Chrome();
        web.setWebChromeClient(chrome);

        if (state != null) {
            web.restoreState(state);
        } else {
            web.loadUrl(debugAsked(getIntent()) ? DEBUG_URL : START_URL);
        }
    }

    /** The page's boot self-check runs only when a launch explicitly asked for it. */
    private static boolean debugAsked(Intent intent) {
        try {
            return intent != null && intent.getBooleanExtra(EXTRA_DEBUG, false);
        } catch (Exception e) {
            return false;
        }
    }

    private static boolean hostAllowed(String host) {
        if (host == null) {
            return false;
        }
        host = host.toLowerCase();
        if (HOST.equals(host)) {
            return true;
        }
        for (String domain : ALLOWED_HOSTS) {
            if (host.equals(domain) || host.endsWith("." + domain)) {
                return true;
            }
        }
        return false;
    }

    private static WebResourceResponse blocked(String why) {
        Map<String, String> headers = new HashMap<>();
        headers.put("Cache-Control", "no-store");
        return new WebResourceResponse("text/plain", "utf-8", 403, why, headers,
                new ByteArrayInputStream(new byte[0]));
    }

    private static String mimeOf(String path) {
        if (path.endsWith(".html") || path.endsWith(".htm")) return "text/html";
        if (path.endsWith(".js")) return "application/javascript";
        if (path.endsWith(".css")) return "text/css";
        if (path.endsWith(".json")) return "application/json";
        if (path.endsWith(".png")) return "image/png";
        if (path.endsWith(".webp")) return "image/webp";
        if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
        if (path.endsWith(".svg")) return "image/svg+xml";
        if (path.endsWith(".woff2")) return "font/woff2";
        return "application/octet-stream";
    }

    private void openExternally(Uri uri) {
        try {
            Intent i = new Intent(Intent.ACTION_VIEW, uri);
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(i);
        } catch (Exception ignored) {
            // Nothing can handle the link; stay in the app.
        }
    }

    private class Chrome extends WebChromeClient {
        /**
         * The page's startup timeline (a single "lt-startup ..." line per launch) is the
         * only console output that reaches logcat: `adb logcat -s LiquidTube` shows the
         * boot milestones of every run, so a startup regression is visible on a device
         * instead of only in a benchmark. Everything else the page, an embed or a
         * third-party script prints is dropped, so nothing else can end up in the log.
         */
        @Override
        public boolean onConsoleMessage(ConsoleMessage m) {
            String msg = m == null ? null : m.message();
            if (msg != null && msg.startsWith(LOG_PREFIX)) {
                Log.i(TAG, msg);
            }
            return true;
        }

        @Override
        public void onShowCustomView(View view, CustomViewCallback callback) {
            if (view == null) {
                if (callback != null) {
                    callback.onCustomViewHidden();
                }
                return;
            }
            /* A second request while one video is already fullscreen is refused, as
               before: the video on screen keeps playing instead of being torn down
               under the user by a request that cannot be honoured. */
            if (customView != null) {
                if (callback != null) {
                    callback.onCustomViewHidden();
                }
                return;
            }
            /* The video view can still be attached to the WebView's own hierarchy after
               an interrupted transition, and addView() on an attached child throws
               "The specified child already has a parent" — a crash in the middle of a
               video. It is detached from wherever it is before it is adopted. */
            ViewGroup parent = (ViewGroup) view.getParent();
            if (parent != null) {
                parent.removeView(view);
            }
            FrameLayout holder = new FrameLayout(MainActivity.this);
            holder.setBackgroundColor(Color.BLACK);
            holder.addView(view, new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
            root.addView(holder, new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
            /* The fields are set only once the view is really on screen, so a failure
               above leaves no half-entered fullscreen state behind. */
            fullscreenHolder = holder;
            customView = view;
            customViewCallback = callback;
            if (web != null) {
                /* Raised first: hiding the WebView makes the page report itself hidden, and the
                   player must not free itself under a video the user is watching (item 8.10). */
                web.evaluateJavascript(FS_JS, null);
                web.setVisibility(View.GONE);
            }
            enterImmersive();
        }

        @Override
        public void onHideCustomView() {
            exitFullscreen();
        }

        @Override
        public void onPermissionRequest(PermissionRequest request) {
            if (request != null) {
                request.deny();
            }
        }
    }

    /**
     * The one way out of fullscreen, and safe to call when nothing is fullscreen.
     *
     * <p>Everything it needs is copied into locals and the fields are cleared first, so
     * a second call — the Back key and the player's own exit button can both land in
     * the same frame, and the Activity can be destroyed while the callback is still
     * pending — finds nothing to do instead of a null holder to remove, and no field
     * is left half-cleared for the next enter to trip over.</p>
     *
     * <p>Order matters. The bars come back while the WebView is still hidden, so the
     * page is resized to the window it had before fullscreen and is already the right
     * size the moment it becomes visible: no frame of the video sheet laid out under a
     * bar that is still on its way in. The callback goes last, because it is what makes
     * the WebView leave its own fullscreen element, and by then the surface it was
     * drawing into is detached and the page is back.</p>
     */
    private void exitFullscreen() {
        FrameLayout holder = fullscreenHolder;
        View shown = customView;
        WebChromeClient.CustomViewCallback callback = customViewCallback;
        boolean wasFullscreen = holder != null || shown != null || callback != null;
        fullscreenHolder = null;
        customView = null;
        customViewCallback = null;
        if (!wasFullscreen) {
            /* Nothing to undo, but a stray exit must still not leave the window
               immersive: the flags are restored only if this app made it so. */
            return;
        }
        leaveImmersive();
        if (holder != null) {
            /* Drop the video surface before the holder goes, so the decoder is released
               with the view and not whenever the holder is collected. */
            holder.removeAllViews();
            if (holder.getParent() == root) {
                root.removeView(holder);
            }
        } else if (shown != null && shown.getParent() == root) {
            root.removeView(shown);
        }
        if (web != null) {
            /* The flag comes down before the page is visible again: the video is the user's
               again, so a later background is allowed to free it (item 8.10). */
            web.evaluateJavascript(UNFS_JS, null);
            web.setVisibility(View.VISIBLE);
        }
        if (callback != null) {
            try {
                callback.onCustomViewHidden();
            } catch (RuntimeException e) {
                /* A WebView that is being destroyed can refuse the callback. The screen is
                   already back to normal at this point, so this costs the embed's own
                   fullscreen flag and nothing the user can see. */
                Log.w(TAG, "lt-fullscreen exit callback refused", e);
            }
        }
    }

    private void enterImmersive() {
        View d = getWindow().getDecorView();
        if (preFullscreenUiFlags < 0) {
            preFullscreenUiFlags = d.getSystemUiVisibility();
        }
        d.setSystemUiVisibility(View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_FULLSCREEN
                | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
    }

    private void leaveImmersive() {
        int restore = preFullscreenUiFlags;
        preFullscreenUiFlags = -1;
        getWindow().getDecorView().setSystemUiVisibility(
                restore < 0 ? View.SYSTEM_UI_FLAG_VISIBLE : restore);
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    public void onBackPressed() {
        if (customView != null || fullscreenHolder != null) {
            /* Back while a video is fullscreen leaves fullscreen, through the same exit
               the player's own button and the destroy path use. */
            exitFullscreen();
            return;
        }
        web.evaluateJavascript(BACK_JS, value -> {
            if (value == null || value.contains("none")) {
                finish();
            }
        });
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (web != null && customView == null && fullscreenHolder == null) {
            /* Before the WebView is paused: the player's frame, its decoder and its audio route
               are given back now, so an app in the background is not holding a media pipeline
               the system will reclaim first (item 8.10). Skipped in fullscreen, where the video
               is on screen and the user is watching it. */
            web.evaluateJavascript(BG_FREE_JS, null);
        }
        web.onPause();
        web.pauseTimers();
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
        web.resumeTimers();
        if (web != null) {
            /* The way back: the same video at the same position, playing only if it was (8.10). */
            web.evaluateJavascript(BG_RESTORE_JS, null);
        }
    }

    /**
     * A long session grows memory the page cannot see and therefore cannot give
     * back: the renderer's decoded images, its paint records, the in-memory half
     * of the HTTP cache. None of it is JavaScript heap, so no amount of care in
     * `index.html` releases it — and until now the app ignored every
     * memory-pressure callback the system sends, which left the low-memory killer
     * as the only way a long session could ever end.
     *
     * `freeMemory()` asks the renderer to drop what it can rebuild — Blink's
     * caches and the decoded bitmaps behind the thumbnails — and costs a
     * re-decode, not a request. `clearCache(false)` drops only the RAM half of
     * the resource cache; the disk cache, and with it the next launch, is
     * untouched. Neither touches the document, so the page keeps its state and
     * nothing on screen changes.
     *
     * Only the levels that say this process is actually short of memory are
     * answered. `TRIM_MEMORY_UI_HIDDEN` is not one of them: an app the user just
     * backgrounded is expected to come straight back, and paying for a reload it
     * did not need is the cost this app should not take.
     */
    @Override
    public void onTrimMemory(int level) {
        super.onTrimMemory(level);
        if (web == null) {
            return;
        }
        switch (level) {
            case ComponentCallbacks2.TRIM_MEMORY_RUNNING_LOW:
            case ComponentCallbacks2.TRIM_MEMORY_RUNNING_CRITICAL:
            case ComponentCallbacks2.TRIM_MEMORY_COMPLETE:
                web.freeMemory();
                web.clearCache(false);
                Log.i(TAG, "lt-trim level=" + level);
                break;
            default:
                break;
        }
    }

    /** The system's last warning before it starts killing: drop everything cacheable. */
    @Override
    public void onLowMemory() {
        super.onLowMemory();
        if (web == null) {
            return;
        }
        web.freeMemory();
        web.clearCache(false);
        Log.i(TAG, "lt-trim level=low");
    }

    @Override
    protected void onDestroy() {
        /* A WebView destroyed while still holding a fullscreen callback never gets its
           exit: the holder, the video surface and the callback would outlive the
           Activity, and the page would come back on the next launch still believing it
           is fullscreen. The exit runs first, while there is still a WebView to tell. */
        exitFullscreen();
        if (web != null) {
            root.removeView(web);
            web.destroy();
        }
        super.onDestroy();
    }
}
