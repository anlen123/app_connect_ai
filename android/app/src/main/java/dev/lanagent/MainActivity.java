package dev.lanagent;

import android.Manifest;
import android.app.*;
import android.content.*;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.*;
import android.view.*;
import android.widget.*;
import com.google.zxing.integration.android.IntentIntegrator;
import com.google.zxing.integration.android.IntentResult;
import org.json.*;
import java.util.*;

public class MainActivity extends Activity implements AgentService.Listener {
    private static final int BG = Color.rgb(17,23,19), PANEL = Color.rgb(25,34,28), INK = Color.rgb(230,237,223), MUTED = Color.rgb(158,177,159), ACID = Color.rgb(212,239,129), ORANGE = Color.rgb(255,188,133);
    private LinearLayout root, timeline, choiceArea;
    private TextView connection, status, title, modelLabel;
    private EditText prompt, urlInput, tokenInput;
    private Spinner sessionPicker;
    private ScrollView scroll;
    private Button send;
    private String selected, wanted;
    private boolean rendering, screenReady, scheduled, forceScroll;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ArrayList<String> sessionIds = new ArrayList<>();
    private final Map<String, TextView> rowViews = new LinkedHashMap<>();
    private final Map<String, StringBuilder> rowText = new LinkedHashMap<>();
    private long renderedSeq;
    private String choiceSignature = "";

    @Override public void onCreate(Bundle state) {
        super.onCreate(state); if (state != null) selected = state.getString("session");
        wanted = getIntent().getStringExtra("sessionId");
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) requestPermissions(new String[]{ Manifest.permission.POST_NOTIFICATIONS }, 100);
        if (Pairing.load(this) == null) showPairing(); else { showWorkspace(); startMonitor(); }
    }
    @Override protected void onNewIntent(Intent intent) { super.onNewIntent(intent); setIntent(intent); wanted = intent.getStringExtra("sessionId"); changed(); }
    @Override protected void onSaveInstanceState(Bundle state) { state.putString("session", selected); super.onSaveInstanceState(state); }
    @Override protected void onResume() { super.onResume(); attach(); }
    private void attach() { if (AgentService.current != null) { AgentService.current.listener = this; changed(); } }
    @Override protected void onPause() { if (AgentService.current != null && AgentService.current.listener == this) AgentService.current.listener = null; super.onPause(); }
    private int dp(float n) { return (int) (n * getResources().getDisplayMetrics().density + .5f); }
    private LinearLayout column() { LinearLayout l = new LinearLayout(this); l.setOrientation(LinearLayout.VERTICAL); return l; }
    private LinearLayout row() { LinearLayout l = new LinearLayout(this); l.setOrientation(LinearLayout.HORIZONTAL); l.setGravity(Gravity.CENTER_VERTICAL); return l; }
    private GradientDrawable background(int color) { GradientDrawable g = new GradientDrawable(); g.setColor(color); g.setCornerRadius(dp(8)); return g; }
    private TextView text(String value, int size, int color) { TextView t = new TextView(this); t.setText(value); t.setTextColor(color); t.setTextSize(size); t.setPadding(0, dp(6), 0, dp(6)); return t; }
    private Button button(String value, View.OnClickListener click) { Button b = new Button(this); b.setText(value); b.setTextColor(BG); b.setBackgroundTintList(android.content.res.ColorStateList.valueOf(ACID)); b.setAllCaps(false); b.setOnClickListener(click); return b; }
    private EditText input(String hint, boolean secret) { EditText e = new EditText(this); e.setHint(hint); e.setTextColor(INK); e.setHintTextColor(MUTED); e.setTextSize(15); e.setBackground(background(PANEL)); e.setPadding(dp(12),dp(12),dp(12),dp(12)); if (secret) e.setInputType(android.text.InputType.TYPE_CLASS_TEXT | android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD); return e; }
    private void base() {
        root = column(); root.setBackgroundColor(BG); root.setPadding(dp(20), dp(12), dp(20), dp(12)); setContentView(root);
        if (Build.VERSION.SDK_INT >= 30) root.setOnApplyWindowInsetsListener((v, insets) -> { android.graphics.Insets system = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.ime()); v.setPadding(dp(20) + system.left, dp(12) + system.top, dp(20) + system.right, dp(12) + system.bottom); return insets; });
        root.requestApplyInsets();
    }
    private void showPairing() {
        screenReady = false; base();
        TextView brand = text("L↗A", 54, ACID); brand.setTypeface(Typeface.create("serif", Typeface.BOLD_ITALIC)); root.addView(brand);
        root.addView(text("LAN AGENT / 移动控制室", 12, MUTED));
        TextView heading = text("工作在电脑。\n掌控在手边。", 32, INK); heading.setTypeface(Typeface.create("serif", Typeface.NORMAL)); root.addView(heading);
        root.addView(text("连接 Linux 网页服务，与电脑/手机网页共享 pi / Codex 会话。\n二维码和配对码包含访问权限，请勿分享。", 14, MUTED));
        urlInput = input("http://192.168.1.10:8787", false); urlInput.setSingleLine(true); root.addView(urlInput);
        tokenInput = input("终端显示的配对码（不是 API key）", true); tokenInput.setSingleLine(true); LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(-1,-2); p.topMargin = dp(12); root.addView(tokenInput,p);
        Pairing saved = Pairing.load(this); if (saved != null) { urlInput.setText(saved.url); tokenInput.setText(saved.token); }
        root.addView(button("连接电脑 ↗", v -> { try { connectPair(new Pairing(urlInput.getText().toString(), tokenInput.getText().toString())); } catch (Exception e) { error(e.getMessage()); } }));
        root.addView(button("扫描电脑二维码", v -> new IntentIntegrator(this).setDesiredBarcodeFormats(IntentIntegrator.QR_CODE).setPrompt("扫描 LAN Agent 电脑端二维码").setBeepEnabled(false).setOrientationLocked(false).initiateScan()));
        root.addView(button("粘贴二维码内容", v -> { EditText raw = input("{version,url,token}", false); new AlertDialog.Builder(this).setTitle("连接信息").setView(raw).setNegativeButton("取消",null).setPositiveButton("连接",(d,w) -> { try { connectPair(Pairing.parse(raw.getText().toString())); } catch (Exception e) { error("二维码无效: " + e.getMessage()); } }).show(); }));
    }
    private void connectPair(Pairing p) throws Exception {
        p.save(this); selected = null; showWorkspace(); startMonitor();
    }
    private void startMonitor() {
        startForegroundService(new Intent(this, AgentService.class));
        main.postDelayed(this::attach, 200);
    }
    @Override protected void onActivityResult(int request, int result, Intent data) {
        IntentResult scan = IntentIntegrator.parseActivityResult(request, result, data);
        if (scan != null) { if (scan.getContents() != null) { try { connectPair(Pairing.parse(scan.getContents())); } catch (Exception e) { error("二维码无效: " + e.getMessage()); } } }
        else super.onActivityResult(request, result, data);
    }
    private void showWorkspace() {
        screenReady = true; base(); rowViews.clear(); rowText.clear(); renderedSeq = 0; choiceSignature = "";
        LinearLayout top = row(); TextView brand = text("L↗A", 26, ACID); brand.setTypeface(Typeface.create("serif", Typeface.BOLD_ITALIC)); top.addView(brand,new LinearLayout.LayoutParams(0,-2,1)); top.addView(button("连接", v -> showPairing())); root.addView(top);
        connection = text("连接中…",12,MUTED); root.addView(connection);
        LinearLayout pick = row(); sessionPicker = new Spinner(this); pick.addView(sessionPicker,new LinearLayout.LayoutParams(0,-2,1)); pick.addView(button("＋",v -> createSession())); root.addView(pick);
        sessionPicker.setOnItemSelectedListener(new android.widget.AdapterView.OnItemSelectedListener() {
            public void onItemSelected(AdapterView<?> a, View view, int position, long id) { if (!rendering && position < sessionIds.size()) select(sessionIds.get(position)); }
            public void onNothingSelected(AdapterView<?> a) {}
        });
        title = text("新建一个会话开始",18,INK); root.addView(title);
        status = text("对话、思考和工具进度实时同步",12,MUTED); root.addView(status);
        LinearLayout tools = row(); modelLabel = text("模型",12,ACID); modelLabel.setMaxLines(2); modelLabel.setEllipsize(android.text.TextUtils.TruncateAt.END); modelLabel.setOnClickListener(v -> switchModel()); tools.addView(modelLabel,new LinearLayout.LayoutParams(0,-2,1)); tools.addView(button("停止", v -> call("abort",new JSONObject(),(d,e) -> { if (e != null) error(e); }))); tools.addView(button("⋯", v -> sessionActions())); root.addView(tools);
        scroll = new ScrollView(this); LinearLayout content = column(); choiceArea = column(); timeline = column(); content.addView(choiceArea); content.addView(timeline); scroll.addView(content); root.addView(scroll,new LinearLayout.LayoutParams(-1,0,1));
        LinearLayout composer = row(); prompt = input("输入任务或回复…",false); prompt.setMinLines(1); prompt.setMaxLines(4); prompt.setInputType(android.text.InputType.TYPE_CLASS_TEXT | android.text.InputType.TYPE_TEXT_FLAG_MULTI_LINE | android.text.InputType.TYPE_TEXT_FLAG_CAP_SENTENCES);
        composer.addView(prompt,new LinearLayout.LayoutParams(0,-2,1)); send = button("发送 ↗", v -> {
            String value = prompt.getText().toString(); if (value.trim().isEmpty()) return;
            JSONObject p = new JSONObject(); AgentService.put(p,"text",value); send.setEnabled(false);
            call("prompt",p,(d,e) -> { if (e != null) { error(e); send.setEnabled(true); } else if (prompt.getText().toString().equals(value)) prompt.setText(""); });
        }); composer.addView(send); root.addView(composer);
        TextView notificationHint = text(getSystemService(NotificationManager.class).areNotificationsEnabled() ? "保持后台监听可接收完成 / 待选择通知" : "通知未开启 · 点击允许完成 / 待选择通知",10,MUTED);
        notificationHint.setOnClickListener(v -> startActivity(new Intent(android.provider.Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(android.provider.Settings.EXTRA_APP_PACKAGE,getPackageName()))); root.addView(notificationHint); changed();
    }
    private JSONObject active() {
        AgentService s = AgentService.current; if (s == null) return null;
        for (int i = 0; i < s.sessions.length(); i++) { JSONObject item = s.sessions.optJSONObject(i); if (item != null && item.optString("id").equals(selected)) return item; } return null;
    }
    @Override public void changed() { if (!screenReady || scheduled) return; scheduled = true; main.postDelayed(() -> { scheduled = false; render(); }, 80); }
    @Override public void error(String text) { Toast.makeText(this, text == null ? "未知错误" : text, Toast.LENGTH_LONG).show(); }
    private void render() {
        AgentService service = AgentService.current; if (!screenReady || service == null) return;
        connection.setText(service.connection);
        ArrayList<String> ids = new ArrayList<>(), labels = new ArrayList<>();
        for (int i = 0; i < service.sessions.length(); i++) { JSONObject s = service.sessions.optJSONObject(i); ids.add(s.optString("id")); labels.add(s.optString("agent").toUpperCase(Locale.ROOT) + " / " + s.optString("title")); }
        if (wanted != null && ids.contains(wanted)) { selected = wanted; wanted = null; resetTimeline(); }
        if (selected != null && !ids.contains(selected)) { selected = null; resetTimeline(); prompt.setText(""); }
        if (selected == null && !ids.isEmpty()) { selected = ids.get(ids.size()-1); resetTimeline(); }
        rendering = true;
        if (!ids.equals(sessionIds) || sessionPicker.getAdapter() == null) {
            sessionIds.clear(); sessionIds.addAll(ids);
            ArrayAdapter<String> adapter = new ArrayAdapter<>(this,android.R.layout.simple_spinner_item, labels); adapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item); sessionPicker.setAdapter(adapter);
        }
        if (ids.contains(selected)) sessionPicker.setSelection(ids.indexOf(selected));
        // Spinner selection callbacks can be deferred to the next layout.
        main.post(() -> rendering = false);
        JSONObject s = active(); if (s == null) { title.setText("新建一个会话开始"); status.setText("与 Linux 网页共享会话；点击 ＋ 选择 agent"); modelLabel.setText("模型"); send.setEnabled(false); return; }
        title.setText(s.optString("title")); String phase = s.optString("status"); status.setText(phase + " · " + s.optInt("turns") + " 轮 · " + s.optInt("tools") + " 工具\n" + s.optString("cwd")); modelLabel.setText(s.optString("model") + " ▾");
        send.setEnabled(s.optBoolean("ready",!phase.equals("offline")) && !Arrays.asList("running","waiting","starting","offline").contains(phase));
        renderChoices(service.choices.get(selected));
        ArrayList<JSONObject> all = service.events.get(selected);
        if (all == null) return;
        View child = scroll.getChildAt(0); boolean bottom = child == null || child.getHeight() - scroll.getScrollY() - scroll.getHeight() < dp(100);
        for (JSONObject e : all) { if (e.optLong("seq") > renderedSeq) { renderEvent(e); renderedSeq = e.optLong("seq"); } }
        var pendingChoices = service.choices.get(selected);
        if ((bottom || forceScroll) && (pendingChoices == null || pendingChoices.isEmpty())) scroll.post(() -> scroll.fullScroll(View.FOCUS_DOWN));
        forceScroll = false;
    }
    private void select(String id) { if (id.equals(selected)) return; selected = id; resetTimeline(); AgentService s = AgentService.current; if (s != null) s.subscribe(id); changed(); }
    private void resetTimeline() { forceScroll = true; if (timeline != null) timeline.removeAllViews(); if (choiceArea != null) choiceArea.removeAllViews(); rowViews.clear(); rowText.clear(); renderedSeq = 0; choiceSignature = ""; }
    private void renderEvent(JSONObject e) {
        String type = e.optString("event"); if (Arrays.asList("choice","choice_closed","model","status").contains(type)) return;
        String channel = e.optString("channel",type), key = e.has("key") ? channel + ":" + e.optString("key") : "event:" + e.optLong("seq");
        TextView body = rowViews.get(key);
        if (body == null) {
            LinearLayout card = column(); card.setPadding(dp(12),dp(10),dp(12),dp(10)); card.setBackground(background(PANEL));
            TextView label = text(channel.toUpperCase(Locale.ROOT) + " / " + android.text.format.DateFormat.format("HH:mm:ss",e.optLong("timestamp")),10,channel.equals("thinking") ? ACID : MUTED); label.setTypeface(Typeface.MONOSPACE); card.addView(label);
            body = text("",14,channel.equals("error") ? ORANGE : INK); body.setTextIsSelectable(true); if (channel.equals("thinking")) body.setTypeface(Typeface.create("serif",Typeface.ITALIC)); card.addView(body);
            LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(-1,-2); p.bottomMargin = dp(12); timeline.addView(card,p); rowViews.put(key,body); rowText.put(key,new StringBuilder());
        }
        String value = e.optString("text", "");
        if (type.equals("tool")) value = e.optString("name") + " · " + e.optString("status") + "\n" + pretty(e.opt("detail"));
        if (type.equals("progress") && e.has("detail")) value += "\n" + pretty(e.opt("detail"));
        if (type.equals("completed")) value = "任务 " + e.optString("status") + (e.has("error") ? "\n" + pretty(e.opt("error")) : "");
        if (type.equals("plan")) { JSONArray steps = e.optJSONArray("steps"); StringBuilder plan = new StringBuilder(e.optString("explanation","")); if (steps != null) for (int i=0;i<steps.length();i++) { JSONObject step = steps.optJSONObject(i); plan.append("\n").append(step.optString("status").equals("completed") ? "✓ " : "○ ").append(step.optString("step")).append(" · ").append(step.optString("status")); } value = plan.toString(); }
        StringBuilder text = rowText.get(key);
        if (type.equals("delta") || type.equals("tool_output")) text.append(value); else { text.setLength(0); text.append(value); }
        body.setText(text.toString());
    }
    private String pretty(Object value) { try { if (value instanceof JSONObject) return ((JSONObject)value).toString(2); if (value instanceof JSONArray) return ((JSONArray)value).toString(2); return value == null ? "" : value.toString(); } catch (Exception e) { return String.valueOf(value); } }
    private void renderChoices(LinkedHashMap<String,JSONObject> pending) {
        String signature = pending == null ? "" : pending.toString(); if (signature.equals(choiceSignature)) return; choiceSignature = signature; choiceArea.removeAllViews(); if (pending == null) return;
        if (!pending.isEmpty()) scroll.post(() -> scroll.scrollTo(0, 0));
        for (JSONObject c : pending.values()) {
            LinearLayout card = column(); card.setPadding(dp(12),dp(12),dp(12),dp(12)); card.setBackground(background(Color.rgb(52,41,30))); card.addView(text(c.optString("title","需要你的选择"),18,ORANGE));
            TextView detail = text(c.optString("message",""),12,INK); detail.setTextIsSelectable(true); card.addView(detail);
            String kind = c.optString("kind");
            if (kind.equals("confirm")) { card.addView(button("确认",v -> answer(c,object("value",true)))); card.addView(button("拒绝",v -> answer(c,object("value",false)))); }
            else if (kind.equals("questions")) {
                JSONArray questions = c.optJSONArray("questions"); Map<String,EditText> fields = new LinkedHashMap<>();
                if (questions != null) for (int i=0;i<questions.length();i++) { JSONObject q = questions.optJSONObject(i); card.addView(text(q.optString("question"),15,INK)); JSONArray options = q.optJSONArray("options"); EditText field = input("填写答案，也可点击选项",q.optBoolean("isSecret"));
                    if (options != null) for (int j=0;j<options.length();j++) { JSONObject option = options.optJSONObject(j); String label = option.optString("label"); card.addView(button(label + " · " + option.optString("description"),v -> field.setText(label))); }
                    card.addView(field); fields.put(q.optString("id"),field);
                }
                card.addView(button("提交答案",v -> { JSONObject answers = new JSONObject(); for (var item : fields.entrySet()) { if (item.getValue().getText().toString().trim().isEmpty()) { error("请回答所有问题"); return; } AgentService.put(answers,item.getKey(),new JSONArray().put(item.getValue().getText().toString())); } answer(c,object("answers",answers)); }));
            } else if (kind.equals("input") || kind.equals("editor") || kind.equals("elicitation")) {
                EditText field = input(kind.equals("elicitation") ? "JSON 对象（遵循请求 schema）" : "输入回答",false); field.setText(c.optString("prefill","")); card.addView(field);
                card.addView(button("提交",v -> { try { answer(c,object(kind.equals("elicitation") ? "content" : "value", kind.equals("elicitation") ? new JSONObject(field.getText().toString()) : field.getText().toString())); } catch (Exception e) { error("输入格式错误"); } }));
            } else { JSONArray options = c.optJSONArray("options"); if (options != null) for(int i=0;i<options.length();i++) { String option = options.optString(i); card.addView(button(option,v -> answer(c,object("value",option)))); } }
            if (!kind.equals("questions") && !kind.equals("approval")) card.addView(button("放弃回答",v -> answer(c,object("cancelled",true))));
            LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(-1,-2); p.bottomMargin=dp(12); choiceArea.addView(card,p);
        }
    }
    private void sessionActions() {
        if (active() == null) { error("请先选择会话"); return; }
        final String target = selected;
        new AlertDialog.Builder(this).setTitle("会话操作").setItems(new String[]{"关闭进程（保留历史）","删除会话"},(dialog,index) -> {
            if (index == 0) call("close",object("sessionId",target),(data,e) -> { if (e != null) error(e); });
            else new AlertDialog.Builder(this).setTitle("删除会话？").setMessage("将停止该 agent 并删除本服务的聊天记录，网页和 APP 同步移除，不能撤销。").setNegativeButton("保留",null).setPositiveButton("删除",(d,w) -> call("delete",object("sessionId",target),(data,e) -> { if (e != null) error(e); })).show();
        }).show();
    }
    private JSONObject object(String key, Object value) { JSONObject obj = new JSONObject(); AgentService.put(obj,key,value); return obj; }
    private void answer(JSONObject choice, JSONObject answer) { JSONObject p = object("requestId",choice.optString("requestId")); AgentService.put(p,"answer",answer); call("answer",p,(d,e) -> { if (e != null) error(e); }); }
    private void call(String type, JSONObject p, AgentService.Callback cb) { if (AgentService.current == null) { cb.done(null,"尚未连接"); return; } if (selected != null && !p.has("sessionId")) AgentService.put(p,"sessionId",selected); AgentService.current.command(type,p,cb); }
    private void createSession() {
        LinearLayout form = column(); form.setPadding(dp(20),dp(12),dp(20),0); Spinner agent = new Spinner(this); agent.setAdapter(new ArrayAdapter<>(this,android.R.layout.simple_spinner_dropdown_item,new String[]{"pi","codex"})); form.addView(agent); EditText cwd = input("项目目录（桥接根目录内）",false); cwd.setText("."); form.addView(cwd);
        AlertDialog d = new AlertDialog.Builder(this).setTitle("新建会话").setView(form).setNegativeButton("取消",null).setPositiveButton("创建",null).create(); d.setOnShowListener(x -> d.getButton(-1).setOnClickListener(v -> {
            JSONObject p = object("agent",agent.getSelectedItem().toString()); AgentService.put(p,"cwd",cwd.getText().toString()); d.getButton(-1).setEnabled(false);
            call("create",p,(data,error) -> { d.getButton(-1).setEnabled(true); if (error != null) { MainActivity.this.error(error); return; } select(data.optString("id")); d.dismiss(); });
        })); d.show();
    }
    private void switchModel() {
        JSONObject s = active(); if (s == null) return; if (!s.optBoolean("ready",!s.optString("status").equals("offline")) || Arrays.asList("running","waiting","starting","offline").contains(s.optString("status"))) { error("任务结束后才能切换模型"); return; }
        JSONArray models = s.optJSONArray("models"); if (models == null || models.length()==0) { error("没有可用模型，请检查电脑端登录配置"); return; }
        String[] names = new String[models.length()]; int checked=0;
        for (int i=0;i<names.length;i++) { JSONObject m = models.optJSONObject(i); names[i]=m.optString("name"); if (m.optString("id").equals(s.optString("model"))) checked=i; }
        new AlertDialog.Builder(this).setTitle("切换模型（保留对话）").setSingleChoiceItems(names,checked,(d,index) -> { JSONObject p=object("model",models.optJSONObject(index).optString("id")); call("model",p,(data,e) -> { if(e!=null) error(e); }); d.dismiss(); }).setNegativeButton("取消",null).show();
    }
}
