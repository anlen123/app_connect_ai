package dev.lanagent;

import android.app.*;
import android.content.*;
import android.os.*;
import org.json.*;
import okhttp3.*;
import java.util.*;
import java.util.concurrent.TimeUnit;

/** All state is main-thread confined. Foreground monitoring survives leaving the activity. */
public class AgentService extends Service {
    public interface Listener { void changed(); void error(String text); }
    public interface Callback { void done(JSONObject data, String error); }
    public static AgentService current;
    public Listener listener;
    public JSONArray sessions = new JSONArray();
    public final Map<String, ArrayList<JSONObject>> events = new LinkedHashMap<>();
    public final Map<String, LinkedHashMap<String, JSONObject>> choices = new LinkedHashMap<>();
    public String connection = "连接中…";
    private final Handler main = new Handler(Looper.getMainLooper());
    private final OkHttpClient client = new OkHttpClient.Builder().pingInterval(20, TimeUnit.SECONDS).connectTimeout(8, TimeUnit.SECONDS).build();
    private WebSocket socket;
    private Pairing pairing;
    private boolean ready, stopped;
    private int generation, retries;
    private final Map<String, Callback> callbacks = new HashMap<>();
    private final Map<String, Runnable> deadlines = new HashMap<>();
    private final Map<String, Long> cursors = new HashMap<>();
    private final Set<String> hydrating = new HashSet<>();
    private NotificationManager notifications;
    private static final String MONITOR = "monitor", ALERT = "task-alerts";

    @Override public void onCreate() {
        super.onCreate(); current = this;
        notifications = getSystemService(NotificationManager.class);
        NotificationChannel monitoring = new NotificationChannel(MONITOR, "局域网连接状态", NotificationManager.IMPORTANCE_LOW);
        NotificationChannel alerts = new NotificationChannel(ALERT, "任务完成与待选择", NotificationManager.IMPORTANCE_HIGH);
        alerts.setDescription("AI 任务结束、失败或等待你的选择");
        notifications.createNotificationChannel(monitoring); notifications.createNotificationChannel(alerts);
        startForeground(1, monitorNotification("连接中…"));
    }
    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        Pairing next = Pairing.load(this);
        if (next == null) { stopSelf(); return START_NOT_STICKY; }
        if (pairing == null || !pairing.url.equals(next.url) || !pairing.token.equals(next.token) || socket == null) {
            if (pairing != null && (!pairing.url.equals(next.url) || !pairing.token.equals(next.token))) { events.clear(); choices.clear(); cursors.clear(); sessions = new JSONArray(); }
            pairing = next; connect();
        }
        return START_STICKY;
    }
    @Override public IBinder onBind(Intent i) { return null; }
    private Notification monitorNotification(String text) {
        Intent stop = new Intent(this, StopReceiver.class).setAction("dev.lanagent.STOP");
        PendingIntent stopIntent = PendingIntent.getBroadcast(this, 0, stop, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        return new Notification.Builder(this, MONITOR).setSmallIcon(android.R.drawable.stat_notify_sync).setContentTitle("LAN Agent · 后台监听").setContentText(text).setOngoing(true).setContentIntent(openIntent(null, 0)).addAction(new Notification.Action.Builder(null, "断开", stopIntent).build()).build();
    }
    private PendingIntent openIntent(String session, int id) {
        Intent i = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        if (session != null) i.putExtra("sessionId", session);
        return PendingIntent.getActivity(this, id, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }
    private String cursorKey(String session) { return pairing.url + "/" + session; }
    private long cursor(String session) { return cursors.computeIfAbsent(session, s -> getSharedPreferences("cursors", 0).getLong(cursorKey(s), -1)); }
    private void connect() {
        final int g = ++generation; if (socket != null) socket.cancel(); ready = false; connection = "连接中…"; update();
        String wsUrl = pairing.url.replaceFirst("^http", "ws") + "/ws";
        socket = client.newWebSocket(new Request.Builder().url(wsUrl).build(), new WebSocketListener() {
            @Override public void onOpen(WebSocket ws, Response response) { main.post(() -> { if (g == generation) { JSONObject auth = new JSONObject(); put(auth, "type", "auth"); put(auth, "token", pairing.token); ws.send(auth.toString()); } }); }
            @Override public void onMessage(WebSocket ws, String text) { main.post(() -> { if (g != generation) return; try { receive(new JSONObject(text)); } catch (Exception e) { report("服务器消息格式错误: " + e.getMessage()); } }); }
            @Override public void onClosed(WebSocket ws, int code, String reason) { main.post(() -> disconnected(g, code, reason)); }
            @Override public void onClosing(WebSocket ws, int code, String reason) { ws.close(code, reason); }
            @Override public void onFailure(WebSocket ws, Throwable error, Response response) { main.post(() -> disconnected(g, 0, error.getMessage())); }
        });
    }
    private void disconnected(int g, int code, String reason) {
        if (g != generation || stopped) return;
        ready = false; socket = null; connection = code == 1008 ? "配对失效，请重新连接" : "已断开，自动重连…";
        for (Runnable r : deadlines.values()) main.removeCallbacks(r); deadlines.clear();
        ArrayList<Callback> pending = new ArrayList<>(callbacks.values()); callbacks.clear();
        for (Callback cb : pending) cb.done(null, "连接已断开，未确认的操作不会自动重发");
        update(); notifications.notify(1, monitorNotification(connection));
        if (code == 1008) { report(connection); return; }
        long delay = Math.min(30000, 1000L << Math.min(retries++, 5));
        main.postDelayed(() -> { if (g == generation && !stopped) connect(); }, delay);
    }
    private void receive(JSONObject r) throws JSONException {
        String type = r.optString("type");
        if (type.equals("hello")) {
            ready = true; retries = 0; connection = "● 已连接 · " + pairing.url; sessions = r.getJSONArray("sessions"); notifications.notify(1, monitorNotification(connection));
            for (int i = 0; i < sessions.length(); i++) subscribe(sessions.getJSONObject(i).getString("id")); update();
        } else if (type.equals("sessions")) {
            sessions = r.getJSONArray("sessions");
            for (int i = 0; i < sessions.length(); i++) { String id = sessions.getJSONObject(i).getString("id"); if (!events.containsKey(id)) subscribe(id); } update();
        } else if (type.equals("response")) {
            String id = r.optString("id"); Callback cb = callbacks.remove(id); Runnable deadline = deadlines.remove(id); if (deadline != null) main.removeCallbacks(deadline);
            if (cb != null) cb.done(r.optJSONObject("data"), r.optBoolean("ok") ? null : r.optString("error", "请求失败"));
        } else if (type.equals("event")) {
            String id = r.getString("sessionId"); long seq = r.getLong("seq");
            ArrayList<JSONObject> list = events.computeIfAbsent(id, k -> new ArrayList<>());
            if (list.isEmpty() || seq > list.get(list.size() - 1).optLong("seq")) { list.add(r); if (list.size() > 10000) list.remove(0); applyChoice(id, r); }
            if (!hydrating.contains(id)) notifyIfNew(id, r, false); update();
        }
    }
    public void subscribe(String id) {
        if (!hydrating.add(id)) return;
        events.putIfAbsent(id, new ArrayList<>());
        JSONObject p = new JSONObject(); put(p, "sessionId", id);
        command("subscribe", p, (data, error) -> {
            hydrating.remove(id);
            if (error != null) { report(error); return; }
            try {
                JSONArray history = data.getJSONArray("events"); ArrayList<JSONObject> merged = new ArrayList<>();
                TreeMap<Long, JSONObject> ordered = new TreeMap<>();
                for (int i = 0; i < history.length(); i++) { JSONObject e = history.getJSONObject(i); ordered.put(e.getLong("seq"), e); }
                // Live events may arrive while a snapshot is in flight. Never overwrite them.
                for (JSONObject e : events.getOrDefault(id, new ArrayList<>())) ordered.put(e.getLong("seq"), e);
                merged.addAll(ordered.values()); events.put(id, merged);
                boolean firstVisit = cursor(id) < 0;
                for (JSONObject e : merged) if (!firstVisit) notifyIfNew(id, e, true);
                LinkedHashMap<String, JSONObject> pending = new LinkedHashMap<>(); JSONArray array = data.optJSONArray("choices");
                if (array != null) for (int i = 0; i < array.length(); i++) { JSONObject c = array.getJSONObject(i); pending.put(c.getString("requestId"), c); }
                choices.put(id, pending);
                long snapshotSeq = data.optLong("seq");
                for (JSONObject e : merged) if (e.optLong("seq") > snapshotSeq) applyChoice(id, e);
                for (JSONObject c : pending.values()) alert(id, "choice-" + c.optString("requestId"), "需要你的选择", c.optString("title", "打开 APP 处理"));
                if (cursor(id) < 0) saveCursor(id, snapshotSeq); update();
            } catch (Exception e) { report(e.getMessage()); }
        });
    }
    private void applyChoice(String id, JSONObject e) {
        var pending = choices.computeIfAbsent(id, k -> new LinkedHashMap<>());
        String type = e.optString("event"), requestId = e.optString("requestId");
        if (type.equals("choice")) pending.put(requestId, e);
        if (type.equals("choice_closed")) { pending.remove(requestId); notifications.cancel(id + ":choice-" + requestId, 2); }
    }
    private void notifyIfNew(String id, JSONObject e, boolean replay) {
        long last = cursor(id), seq = e.optLong("seq");
        if (seq <= last) return;
        if (last < 0 && replay) return; // First pairing: don't notify every historic completion.
        String type = e.optString("event");
        if (type.equals("choice")) alert(id, "choice-" + e.optString("requestId"), "需要你的选择", e.optString("title", "AI 正在等待"));
        if (type.equals("choice_closed")) notifications.cancel(id + ":choice-" + e.optString("requestId"), 2);
        if (type.equals("completed")) alert(id, "done", e.optString("status").equals("completed") ? "任务已完成" : "任务已结束 · " + e.optString("status"), title(id));
        if (type.equals("error") && e.optBoolean("fatal")) alert(id, "done", "Agent 连接出错", e.optString("text"));
        saveCursor(id, seq);
    }
    private void saveCursor(String id, long seq) { cursors.put(id, seq); getSharedPreferences("cursors", 0).edit().putLong(cursorKey(id), seq).apply(); }
    private String title(String id) { for (int i = 0; i < sessions.length(); i++) { JSONObject s = sessions.optJSONObject(i); if (id.equals(s.optString("id"))) return s.optString("title"); } return "LAN Agent"; }
    private void alert(String session, String tag, String title, String text) {
        Notification n = new Notification.Builder(this, ALERT).setSmallIcon(android.R.drawable.ic_dialog_info).setContentTitle(title).setContentText(text).setStyle(new Notification.BigTextStyle().bigText(text)).setAutoCancel(true).setOnlyAlertOnce(true).setContentIntent(openIntent(session, (session + tag).hashCode())).build();
        try { notifications.notify(session + ":" + tag, 2, n); } catch (SecurityException e) { report("请允许通知权限"); }
    }
    public void command(String type, JSONObject fields, Callback cb) {
        if (!ready || socket == null) { cb.done(null, "尚未连接"); return; }
        String id = UUID.randomUUID().toString(); JSONObject obj = fields == null ? new JSONObject() : fields;
        put(obj, "type", type); put(obj, "id", id); callbacks.put(id, cb);
        Runnable deadline = () -> { deadlines.remove(id); Callback c = callbacks.remove(id); if (c != null) c.done(null, "请求超时，请查看会话状态后重试"); };
        deadlines.put(id, deadline); main.postDelayed(deadline, 60000);
        if (!socket.send(obj.toString())) { main.removeCallbacks(deadline); deadlines.remove(id); callbacks.remove(id); cb.done(null, "发送失败"); }
    }
    public static void put(JSONObject obj, String key, Object value) { try { obj.put(key, value); } catch (JSONException e) { throw new IllegalArgumentException(e); } }
    private void update() { if (listener != null) listener.changed(); }
    private void report(String text) { if (listener != null) listener.error(text); }
    @Override public void onDestroy() { stopped = true; generation++; main.removeCallbacksAndMessages(null); if (socket != null) socket.cancel(); client.dispatcher().executorService().shutdown(); current = null; super.onDestroy(); }
    public static class StopReceiver extends BroadcastReceiver { @Override public void onReceive(Context c, Intent i) { c.stopService(new Intent(c, AgentService.class)); } }
}
