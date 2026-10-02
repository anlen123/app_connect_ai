package dev.lanagent;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import org.json.JSONObject;
import java.net.URI;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** Pair credentials stay on device and are encrypted with Android Keystore. */
public final class Pairing {
    public final String url, token;
    public Pairing(String url, String token) {
        String normalized = url.trim();
        if (!normalized.contains("://")) normalized = "http://" + normalized;
        URI uri = URI.create(normalized);
        if (!("http".equals(uri.getScheme()) || "https".equals(uri.getScheme())) || uri.getHost() == null || uri.getUserInfo() != null || uri.getQuery() != null || uri.getFragment() != null || !(uri.getPath().isEmpty() || uri.getPath().equals("/"))) throw new IllegalArgumentException("请输入 http(s)://局域网IP:端口，不要包含路径");
        if (token.trim().length() < 24) throw new IllegalArgumentException("配对码至少 24 个字符");
        this.url = normalized.replaceAll("/+$", ""); this.token = token.trim();
    }
    public static Pairing parse(String qr) throws Exception {
        JSONObject obj = new JSONObject(qr);
        if (obj.optInt("version") != 1) throw new IllegalArgumentException("不支持的二维码版本");
        return new Pairing(obj.getString("url"), obj.getString("token"));
    }
    private static SecretKey key() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore"); store.load(null);
        if (store.containsAlias("lan-agent-pairing")) return (SecretKey) store.getKey("lan-agent-pairing", null);
        KeyGenerator gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        gen.init(new KeyGenParameterSpec.Builder("lan-agent-pairing", KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());
        return gen.generateKey();
    }
    public void save(Context c) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.ENCRYPT_MODE, key());
        JSONObject obj = new JSONObject(); obj.put("url", url); obj.put("token", token);
        String iv = Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP);
        String data = Base64.encodeToString(cipher.doFinal(obj.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8)), Base64.NO_WRAP);
        c.getSharedPreferences("pairing", 0).edit().putString("iv", iv).putString("data", data).apply();
    }
    public static Pairing load(Context c) {
        try {
            var prefs = c.getSharedPreferences("pairing", 0); if (!prefs.contains("data")) return null;
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, Base64.decode(prefs.getString("iv", ""), Base64.NO_WRAP)));
            JSONObject obj = new JSONObject(new String(cipher.doFinal(Base64.decode(prefs.getString("data", ""), Base64.NO_WRAP)), java.nio.charset.StandardCharsets.UTF_8));
            return new Pairing(obj.getString("url"), obj.getString("token"));
        } catch (Exception e) { return null; }
    }
}
