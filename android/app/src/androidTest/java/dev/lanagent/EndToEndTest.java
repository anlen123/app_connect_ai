package dev.lanagent;

import android.app.NotificationManager;
import android.content.*;
import android.widget.EditText;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.test.uiautomator.*;
import org.json.*;
import org.junit.*;
import static org.junit.Assert.*;
import java.io.File;
import java.util.List;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.BooleanSupplier;

/** Runs against bridge/test/fixture-server.js. Exercises real APK networking and OS notifications. */
public class EndToEndTest {
    private UiDevice device;
    private Context context;
    private final String fixtureUrl = InstrumentationRegistry.getArguments().getString("fixtureUrl","http://10.0.2.2:8788");
    private void until(BooleanSupplier condition) throws Exception { long end = System.currentTimeMillis()+15000; while(System.currentTimeMillis()<end) { if(condition.getAsBoolean()) return; Thread.sleep(100); } fail("Condition timed out"); }
    private <T> T onMain(java.util.concurrent.Callable<T> action) { AtomicReference<T> out=new AtomicReference<>(); AtomicReference<Exception> error=new AtomicReference<>(); InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> { try { out.set(action.call()); } catch(Exception e) {error.set(e);} }); if(error.get()!=null) throw new RuntimeException(error.get()); return out.get(); }
    private JSONObject command(String type, JSONObject fields) throws Exception {
        AtomicReference<JSONObject> data = new AtomicReference<>(); AtomicReference<String> error = new AtomicReference<>(); AtomicReference<Boolean> done=new AtomicReference<>(false);
        onMain(() -> { AgentService.current.command(type,fields,(d,e) -> { data.set(d);error.set(e);done.set(true); }); return null; });
        until(done::get); assertNull(error.get()); return data.get();
    }
    private boolean alert(String title) { return java.util.Arrays.stream(context.getSystemService(NotificationManager.class).getActiveNotifications()).anyMatch(n -> title.equals(n.getNotification().extras.getString("android.title"))); }
    @Before public void setup() throws Exception {
        context = InstrumentationRegistry.getInstrumentation().getTargetContext(); device=UiDevice.getInstance(InstrumentationRegistry.getInstrumentation());
        context.stopService(new Intent(context,AgentService.class)); context.getSharedPreferences("pairing",0).edit().clear().commit(); context.getSharedPreferences("cursors",0).edit().clear().commit();
        device.wakeUp(); device.pressHome(); device.pressBack();
        context.getSystemService(NotificationManager.class).cancelAll();
        device.executeShellCommand("pm grant dev.lanagent android.permission.POST_NOTIFICATIONS");
        Intent launch = new Intent(context,MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK); context.startActivity(launch);
        assertTrue(device.wait(Until.hasObject(By.text("连接电脑 ↗")),10000));
    }
    @Test public void manualIpChatThinkingModelsChoicesAndBackgroundNotifications() throws Exception {
        List<UiObject2> fields=device.findObjects(By.clazz(EditText.class)); assertEquals(2,fields.size());
        fields.get(0).setText(fixtureUrl); fields.get(1).setText("test-only-token-0123456789abcdefgh"); device.findObject(By.text("连接电脑 ↗")).click();
        until(() -> onMain(() -> AgentService.current != null && AgentService.current.connection.startsWith("●")));
        int before = onMain(() -> AgentService.current.sessions.length());
        assertTrue(device.wait(Until.hasObject(By.text("＋")),5000)); device.findObject(By.text("＋")).click();
        assertTrue(device.wait(Until.hasObject(By.text("创建")),5000)); device.findObject(By.text("创建")).click();
        until(() -> onMain(() -> AgentService.current.sessions.length()>before && AgentService.current.sessions.optJSONObject(before).optString("status").equals("idle")));
        String id=onMain(() -> AgentService.current.sessions.optJSONObject(before).optString("id"));
        assertTrue(device.wait(Until.hasObject(By.text("test/model-a ▾")),5000)); device.findObject(By.text("test/model-a ▾")).click();
        assertTrue(device.wait(Until.hasObject(By.text("Model B")),5000)); device.findObject(By.text("Model B")).click();
        until(() -> onMain(() -> AgentService.current.sessions.optJSONObject(before).optString("model").equals("test/model-b")));
        UiObject2 prompt=device.findObject(By.clazz(EditText.class)); prompt.setText("安卓端测试任务"); device.findObject(By.text("发送 ↗")).click();
        until(() -> onMain(() -> AgentService.current.events.get(id).stream().anyMatch(e -> e.optString("channel").equals("thinking"))));
        if (device.hasObject(By.pkg("com.google.android.inputmethod.latin"))) device.pressBack();
        new UiScrollable(new UiSelector().scrollable(true)).scrollTextIntoView("正在分析局域网任务");

        assertTrue(device.wait(Until.hasObject(By.text("正在分析局域网任务")),5000));
        device.executeShellCommand("screencap -p /data/local/tmp/lan-chat.png");
        device.pressHome(); until(() -> alert("需要你的选择"));
        device.openNotification(); assertTrue(device.wait(Until.hasObject(By.text("需要你的选择")),5000)); device.executeShellCommand("screencap -p /data/local/tmp/lan-choice-notification.png");
        device.findObject(By.text("需要你的选择")).click();
        assertTrue(device.wait(Until.hasObject(By.text("继续")),5000)); device.findObject(By.text("继续")).click(); device.pressHome();
        until(() -> onMain(() -> AgentService.current.choices.get(id).isEmpty()));
        // Drop the actual transport before the task settles; completion must be replayed on reconnect.
        onMain(() -> { var field = AgentService.class.getDeclaredField("socket"); field.setAccessible(true); ((okhttp3.WebSocket)field.get(AgentService.current)).cancel(); return null; });
        until(() -> onMain(() -> AgentService.current.connection.contains("断开")));
        until(() -> alert("任务已完成")); device.openNotification(); assertTrue(device.wait(Until.hasObject(By.text("任务已完成")),5000)); device.executeShellCommand("screencap -p /data/local/tmp/lan-completed-notification.png");
        device.findObject(By.text("任务已完成")).click();
        assertTrue(device.wait(Until.hasObject(By.text("选择结果：继续")),5000));
        // Both agents are selectable from Android, with history preserved.
        JSONObject p=new JSONObject().put("agent","codex").put("cwd","."); JSONObject codex=command("create",p); assertEquals("codex",codex.getString("agent"));
        // Decode an actual bridge-generated QR bitmap with the same ZXing decoder used by the camera.
        JSONObject paired = command("pair", new JSONObject());
        byte[] png = android.util.Base64.decode(paired.getString("qr").split(",",2)[1],android.util.Base64.DEFAULT);
        android.graphics.Bitmap bitmap=android.graphics.BitmapFactory.decodeByteArray(png,0,png.length);
        int width=bitmap.getWidth(),height=bitmap.getHeight();int[] pixels=new int[width*height];bitmap.getPixels(pixels,0,width,0,0,width,height);
        var binary=new com.google.zxing.BinaryBitmap(new com.google.zxing.common.HybridBinarizer(new com.google.zxing.RGBLuminanceSource(width,height,pixels)));
        String payload=new com.google.zxing.qrcode.QRCodeReader().decode(binary).getText();
        Pairing qr=Pairing.parse(payload); assertEquals(fixtureUrl,qr.url);
        Pairing web=Pairing.parse(paired.getString("browserUrl")); assertEquals(qr.url,web.url); assertEquals(qr.token,web.token);
        onMain(() -> { qr.save(context);return null; }); assertEquals(qr.token,Pairing.load(context).token);
        try { Pairing.parse("{\"version\":2}"); fail("bad QR accepted"); } catch(Exception expected) { }
        device.findObject(By.text("⋯")).click(); assertTrue(device.wait(Until.hasObject(By.text("删除会话")),5000)); device.findObject(By.text("删除会话")).click();
        assertTrue(device.wait(Until.hasObject(By.text("删除")),5000)); device.findObject(By.text("删除")).click();
        until(() -> onMain(() -> !AgentService.current.events.containsKey(id)));
        assertFalse(java.util.Arrays.stream(context.getSystemService(NotificationManager.class).getActiveNotifications()).anyMatch(n -> n.getTag()!=null && n.getTag().startsWith(id+":")));
        command("delete",new JSONObject().put("sessionId",codex.getString("id")));
        assertTrue(device.wait(Until.hasObject(By.text("新建一个会话开始")),5000));
    }
    @Test public void customPairingCodeValidationAndPrivateStorage() throws Exception {
        Pairing custom = new Pairing(fixtureUrl,"CustomPair_42"); custom.save(context); assertEquals(custom.token,Pairing.load(context).token);
        assertEquals(custom.token,Pairing.parse(fixtureUrl+"/#token=CustomPair_42").token);
        for (String bad : new String[]{"short","x".repeat(257),"123456789012\ncontrol"}) {
            try { new Pairing(fixtureUrl,bad); fail("Invalid custom code accepted"); } catch (IllegalArgumentException expected) { }
        }
    }
    @Test public void scannerOpensCameraAndReturnsSafely() throws Exception {
        device.executeShellCommand("pm grant dev.lanagent android.permission.CAMERA");
        device.findObject(By.text("扫描电脑二维码")).click();
        assertTrue(device.wait(Until.hasObject(By.text("扫描 LAN Agent 电脑端二维码")),10000));
        device.executeShellCommand("screencap -p /data/local/tmp/lan-scanner.png");
        device.pressBack();assertTrue(device.wait(Until.hasObject(By.text("连接电脑 ↗")),5000));
    }
}
