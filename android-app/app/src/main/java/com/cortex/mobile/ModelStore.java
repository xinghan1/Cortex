package com.cortex.mobile;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.Toast;
import org.json.JSONArray;
import org.json.JSONObject;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.UUID;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** OpenAI-compatible model profiles. Credentials remain encrypted with Android Keystore. */
final class ModelStore {
    private static final String PROFILES = "model_profiles_v1", SELECTED = "model_selected_v1";
    private final Activity activity;
    private final SharedPreferences prefs;
    ModelStore(Activity activity, SharedPreferences prefs) { this.activity = activity; this.prefs = prefs; migrate(); }
    private JSONArray profiles() { try { return new JSONArray(prefs.getString(PROFILES, "[]")); } catch (Exception e) { return new JSONArray(); } }
    private void migrate() {
        if (prefs.contains(PROFILES)) return;
        JSONArray a = new JSONArray();
        String endpoint = prefs.getString("api_url", ""), model = prefs.getString("model", "");
        if (!endpoint.isEmpty() || !model.isEmpty()) {
            try {
                String id = UUID.randomUUID().toString();
                a.put(new JSONObject().put("id", id).put("name", model.isEmpty() ? "原有模型" : model).put("url", endpoint).put("model", model));
                String old = prefs.getString("api_key", "");
                SharedPreferences.Editor edit = prefs.edit().putString(PROFILES, a.toString()).putString(SELECTED, id);
                if (!old.isEmpty()) edit.putString("model_secret_" + id, old);
                edit.apply(); return;
            } catch (Exception ignored) { }
        }
        prefs.edit().putString(PROFILES, a.toString()).apply();
    }
    private JSONObject selected() {
        JSONArray a = profiles(); String id = prefs.getString(SELECTED, "");
        for (int i=0;i<a.length();i++) { JSONObject o=a.optJSONObject(i); if (o != null && id.equals(o.optString("id"))) return o; }
        return null;
    }
    String selectedName() { JSONObject o=selected(); return o==null ? "选择模型" : o.optString("name", "选择模型"); }
    String selectedUrl() { JSONObject o=selected(); return o==null ? "" : o.optString("url"); }
    String selectedModel() { JSONObject o=selected(); return o==null ? "" : o.optString("model"); }
    String selectedKey() throws Exception { JSONObject o=selected(); return o==null ? "" : readKey(o.optString("id")); }
    private SecretKey key() throws Exception {
        KeyStore ks=KeyStore.getInstance("AndroidKeyStore"); ks.load(null);
        if (!ks.containsAlias("cortex_secrets")) {
            KeyGenerator g=KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES,"AndroidKeyStore");
            g.init(new KeyGenParameterSpec.Builder("cortex_secrets",KeyProperties.PURPOSE_ENCRYPT|KeyProperties.PURPOSE_DECRYPT).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build()); g.generateKey();
        }
        return (SecretKey)ks.getKey("cortex_secrets",null);
    }
    private String encodeKey(String value) throws Exception {
        Cipher c=Cipher.getInstance("AES/GCM/NoPadding"); c.init(Cipher.ENCRYPT_MODE,key());
        return Base64.encodeToString(c.getIV(),Base64.NO_WRAP)+":"+Base64.encodeToString(c.doFinal(value.getBytes(StandardCharsets.UTF_8)),Base64.NO_WRAP);
    }
    private String readKey(String id) throws Exception {
        String v=prefs.getString("model_secret_"+id,""); if(v.isEmpty()) return "";
        String[] p=v.split(":",2); if(p.length!=2) throw new Exception("模型密钥格式无效");
        Cipher c=Cipher.getInstance("AES/GCM/NoPadding"); c.init(Cipher.DECRYPT_MODE,key(),new GCMParameterSpec(128,Base64.decode(p[0],Base64.NO_WRAP)));
        return new String(c.doFinal(Base64.decode(p[1],Base64.NO_WRAP)),StandardCharsets.UTF_8);
    }
    void showSelector(Runnable changed) {
        JSONArray a=profiles(); String[] names=new String[a.length()+1];
        for(int i=0;i<a.length();i++) names[i]=a.optJSONObject(i).optString("name") + (a.optJSONObject(i).optString("id").equals(prefs.getString(SELECTED,"")) ? "  ✓" : "");
        names[a.length()]="管理模型与 API 密钥";
        new AlertDialog.Builder(activity).setTitle("选择模型").setItems(names,(dialog,which)->{
            if(which==a.length()) { showManager(changed); return; }
            prefs.edit().putString(SELECTED,a.optJSONObject(which).optString("id")).apply(); changed.run();
        }).setNegativeButton("取消",null).show();
    }
    void showManager(Runnable changed) {
        JSONArray a=profiles(); String[] names=new String[a.length()+1];
        for(int i=0;i<a.length();i++) { JSONObject o=a.optJSONObject(i); names[i]=o.optString("name")+"  ·  "+o.optString("model"); }
        names[a.length()]="＋ 添加模型";
        new AlertDialog.Builder(activity).setTitle("模型与 API 密钥").setItems(names,(d,which)->{
            if(which==a.length()) edit(null,changed); else {
                JSONObject o=a.optJSONObject(which);
                new AlertDialog.Builder(activity).setTitle(o.optString("name")).setItems(new String[]{"选择此模型","编辑","删除"},(sub,action)->{
                    if(action==0) { prefs.edit().putString(SELECTED,o.optString("id")).apply(); changed.run(); }
                    else if(action==1) edit(o,changed);
                    else new AlertDialog.Builder(activity).setMessage("删除此模型及其保存的密钥？").setPositiveButton("删除",(x,y)->remove(o.optString("id"),changed)).setNegativeButton("取消",null).show();
                }).show();
            }
        }).setNegativeButton("关闭",null).show();
    }
    private EditText field(LinearLayout layout,String hint,String value,boolean secret) {
        EditText e=new EditText(activity); e.setHint(hint); if(secret) e.setInputType(129); e.setText(value); e.setSingleLine(true); layout.addView(e); return e;
    }
    private void edit(JSONObject old,Runnable changed) {
        LinearLayout box=new LinearLayout(activity); box.setOrientation(LinearLayout.VERTICAL); int pad=(int)(20*activity.getResources().getDisplayMetrics().density); box.setPadding(pad,0,pad,0);
        EditText name=field(box,"显示名称，例如 GPT 或 DeepSeek",old==null?"":old.optString("name"),false);
        EditText url=field(box,"HTTPS API 根地址，例如 https://api.openai.com/v1",old==null?"":old.optString("url"),false);
        EditText model=field(box,"模型 ID，例如 gpt-4.1",old==null?"":old.optString("model"),false);
        EditText secret=field(box,old==null?"API 密钥":"API 密钥（留空保留原值）","",true);
        ScrollView scroll=new ScrollView(activity); scroll.addView(box);
        AlertDialog dialog=new AlertDialog.Builder(activity).setTitle(old==null?"添加模型":"编辑模型").setMessage("支持 OpenAI Chat Completions 兼容接口。账号登录可通过连接电脑使用电脑已登录的账号。")
            .setView(scroll).setPositiveButton("保存",null).setNegativeButton("取消",null).create();
        dialog.setOnShowListener(ignored->dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(v->{
            try {
                String label=name.getText().toString().trim(), endpoint=url.getText().toString().trim(), id=old==null?UUID.randomUUID().toString():old.optString("id"), modelId=model.getText().toString().trim();
                URL u=new URL(endpoint); if(!"https".equalsIgnoreCase(u.getProtocol()) || u.getHost().isEmpty() || u.getUserInfo()!=null || u.getQuery()!=null || u.getRef()!=null) throw new Exception("请输入有效的 HTTPS API 根地址");
                if(label.isEmpty() || modelId.isEmpty()) throw new Exception("请填写显示名称和模型 ID");
                String value=secret.getText().toString(); if(value.isEmpty() && (old==null || prefs.getString("model_secret_"+id,"").isEmpty())) throw new Exception("请填写 API 密钥");
                String encoded=value.isEmpty()?null:encodeKey(value);
                JSONArray before=profiles(), after=new JSONArray(); boolean found=false;
                JSONObject updated=new JSONObject().put("id",id).put("name",label).put("url",endpoint).put("model",modelId);
                for(int i=0;i<before.length();i++) { JSONObject row=before.optJSONObject(i); if(row!=null && id.equals(row.optString("id"))) { after.put(updated); found=true; } else if(row!=null) after.put(row); }
                if(!found) after.put(updated);
                SharedPreferences.Editor put=prefs.edit().putString(PROFILES,after.toString()).putString(SELECTED,id); if(encoded!=null) put.putString("model_secret_"+id,encoded); put.apply();
                dialog.dismiss(); changed.run();
            } catch(Exception e) { Toast.makeText(activity,"保存失败："+e.getMessage(),Toast.LENGTH_LONG).show(); }
        })); dialog.show();
    }
    private void remove(String id,Runnable changed) {
        JSONArray a=profiles(), b=new JSONArray(); for(int i=0;i<a.length();i++) { JSONObject o=a.optJSONObject(i); if(o!=null && !id.equals(o.optString("id"))) b.put(o); }
        SharedPreferences.Editor e=prefs.edit().putString(PROFILES,b.toString()).remove("model_secret_"+id);
        if(id.equals(prefs.getString(SELECTED,""))) e.putString(SELECTED,b.length()>0?b.optJSONObject(0).optString("id"):""); e.apply(); changed.run();
    }
}
