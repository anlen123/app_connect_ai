package dev.lanagent;

import android.app.NotificationManager;
import android.content.*;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.test.uiautomator.UiDevice;
import org.json.*;
import org.junit.*;
import static org.junit.Assert.*;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.BooleanSupplier;

/** Optional live test. Arguments realUrl/realToken are supplied from a private local token file. */
public class RealAgentTest {
    private Context context;
    private <T> T onMain(java.util.concurrent.Callable<T> action) { AtomicReference<T> out=new AtomicReference<>(); AtomicReference<Exception> error=new AtomicReference<>(); InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> { try {out.set(action.call());}catch(Exception e){error.set(e);} }); if(error.get()!=null)throw new RuntimeException(error.get());return out.get(); }
    private void until(BooleanSupplier condition) throws Exception {long end=System.currentTimeMillis()+150000;while(System.currentTimeMillis()<end){if(condition.getAsBoolean())return;Thread.sleep(150);}fail("Live agent timed out");}
    private JSONObject command(String type, JSONObject p) throws Exception {AtomicReference<JSONObject> data=new AtomicReference<>();AtomicReference<String> error=new AtomicReference<>();AtomicReference<Boolean> done=new AtomicReference<>(false);onMain(() -> {AgentService.current.command(type,p,(d,e)->{data.set(d);error.set(e);done.set(true);});return null;});until(done::get);assertNull(error.get());return data.get();}
    @Test public void linuxServiceToPiAndCodexFromAndroid() throws Exception {
        String url=InstrumentationRegistry.getArguments().getString("realUrl"),token=InstrumentationRegistry.getArguments().getString("realToken");
        Assume.assumeTrue("Supply private pairing arguments for the live test",url!=null && token!=null);
        context=InstrumentationRegistry.getInstrumentation().getTargetContext(); UiDevice device=UiDevice.getInstance(InstrumentationRegistry.getInstrumentation());device.wakeUp();device.pressHome();
        device.executeShellCommand("pm grant dev.lanagent android.permission.POST_NOTIFICATIONS");context.stopService(new Intent(context,AgentService.class));Thread.sleep(500);
        onMain(() -> {new Pairing(url,token).save(context);return null;});
        context.startActivity(new Intent(context,MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK));
        until(() -> onMain(() -> AgentService.current!=null && AgentService.current.connection.startsWith("●")));
        for(String kind:new String[]{"pi","codex"}) {
            JSONObject session=command("create",new JSONObject().put("agent",kind).put("cwd",InstrumentationRegistry.getArguments().getString("realCwd",".")));String id=session.getString("id");assertTrue(session.getJSONArray("models").length()>0);
            String original = session.getString("model"), alternative = null;
            JSONArray models = session.getJSONArray("models");
            for (int i=0;i<models.length();i++) { String candidate=models.getJSONObject(i).getString("id"); if (!candidate.equals(original) && (!kind.equals("pi") || candidate.startsWith(original.substring(0,original.indexOf('/')+1)))) { alternative=candidate; break; } }
            assertNotNull("A second model is needed to verify switching",alternative);
            JSONObject switched=command("model",new JSONObject().put("sessionId",id).put("model",alternative));assertEquals(alternative,switched.getString("model"));
            JSONObject restored=command("model",new JSONObject().put("sessionId",id).put("model",original));assertEquals(original,restored.getString("model"));
            if (kind.equals("pi")) {
                AtomicReference<Boolean> handled = new AtomicReference<>(false); AtomicReference<String> uiError = new AtomicReference<>();
                onMain(() -> { AgentService.current.command("prompt",new JSONObject().put("sessionId",id).put("text","/lan-check"),(d,e) -> { uiError.set(e); handled.set(true); }); return null; }); device.pressHome();
                until(() -> onMain(() -> AgentService.current.choices.get(id)!=null && !AgentService.current.choices.get(id).isEmpty()));
                JSONObject choice=onMain(() -> AgentService.current.choices.get(id).values().iterator().next()); assertEquals("局域网交互检查",choice.getString("title"));
                assertTrue(java.util.Arrays.stream(context.getSystemService(NotificationManager.class).getActiveNotifications()).anyMatch(n -> n.getTag()!=null && n.getTag().equals(id+":choice-"+choice.optString("requestId"))));
                command("answer",new JSONObject().put("sessionId",id).put("requestId",choice.getString("requestId")).put("answer",new JSONObject().put("value","继续")));
                until(handled::get); assertNull(uiError.get());
                until(() -> onMain(() -> AgentService.current.events.get(id).stream().anyMatch(e -> "notice".equals(e.optString("event")) && e.optString("text").contains("继续"))));
            }
            long baseline=onMain(() -> AgentService.current.events.get(id).stream().mapToLong(e->e.optLong("seq")).max().orElse(0));
            context.getSystemService(NotificationManager.class).cancelAll();
            command("prompt",new JSONObject().put("sessionId",id).put("text","请调用文件读取工具或命令工具查看当前目录（不要写文件），最后只回复 LAN_ANDROID_OK。"));device.pressHome();
            until(() -> onMain(() -> AgentService.current.events.get(id).stream().anyMatch(e -> e.optLong("seq")>baseline && "completed".equals(e.optString("event")))));
            String status=onMain(() -> AgentService.current.events.get(id).stream().filter(e -> "completed".equals(e.optString("event"))).reduce((a,b)->b).get().optString("status"));assertEquals(kind,"completed",status);
            assertTrue(kind,onMain(() -> AgentService.current.events.get(id).stream().anyMatch(e -> "assistant".equals(e.optString("channel")) && e.optString("text").contains("LAN_ANDROID_OK"))));
            assertTrue(kind,onMain(() -> AgentService.current.events.get(id).stream().anyMatch(e -> "tool".equals(e.optString("event")))));
            assertTrue(kind,java.util.Arrays.stream(context.getSystemService(NotificationManager.class).getActiveNotifications()).anyMatch(n -> n.getTag()!=null && n.getTag().equals(id+":done") && "任务已完成".equals(n.getNotification().extras.getString("android.title"))));
            command("delete",new JSONObject().put("sessionId",id));
        }
    }
}
