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
    String selectedProvider() { JSONObject o=selected(); return o==null ? "" : o.optString("provider",""); }
    String selectedAuthMode() { JSONObject o=selected(); return o==null ? "apiKey" : o.optString("authMode","apiKey"); }
    String selectedKey() throws Exception { JSONObject o=selected(); return o==null ? "" : readKey(o.optString("id")); }
    JSONArray allProfiles() { return profiles(); }
    JSONObject selectedProfile() { return selected(); }
    String keyFor(String id) throws Exception { return readKey(id); }
    void selectProfile(String id) { prefs.edit().putString(SELECTED,id).apply(); }
    void saveProfile(JSONObject profile, String secret) throws Exception {
        String id=profile.optString("id"); if(id.isEmpty()) throw new Exception("模型标识无效");
        JSONArray before=profiles(), after=new JSONArray(); boolean found=false;
        for(int i=0;i<before.length();i++){ JSONObject row=before.optJSONObject(i); if(row!=null && id.equals(row.optString("id"))){after.put(profile);found=true;}else if(row!=null)after.put(row); }
        if(!found) after.put(profile);
        SharedPreferences.Editor edit=prefs.edit().putString(PROFILES,after.toString()).putString(SELECTED,id);
        if(secret!=null&&!secret.isEmpty()) edit.putString("model_secret_"+id,encodeKey(secret));
        edit.apply();
    }
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
    void showSelector(android.view.View anchor,Runnable changed) {
        boolean light=prefs.getBoolean("light_theme",false); int bg=light?0xfff7f7f8:0xff242528, fg=light?0xff181a1f:0xfff2f2f3;
        int d=(int)(activity.getResources().getDisplayMetrics().density*12); android.widget.LinearLayout box=new android.widget.LinearLayout(activity);box.setOrientation(android.widget.LinearLayout.VERTICAL);box.setPadding(d,d,d,d);
        android.graphics.drawable.GradientDrawable shape=new android.graphics.drawable.GradientDrawable();shape.setColor(bg);shape.setCornerRadius(d);box.setBackground(shape);
        android.widget.PopupWindow popup=new android.widget.PopupWindow(box,(int)(activity.getResources().getDisplayMetrics().density*260),-2,true);popup.setBackgroundDrawable(new android.graphics.drawable.ColorDrawable(android.graphics.Color.TRANSPARENT));popup.setElevation(d);popup.setOutsideTouchable(true);
        JSONArray a=profiles();android.widget.TextView header=new android.widget.TextView(activity);header.setText("选择模型");header.setTextColor(fg);header.setTextSize(15);header.setPadding(d,d,d,d);box.addView(header);
        android.widget.ScrollView scroll=new android.widget.ScrollView(activity);android.widget.LinearLayout list=new android.widget.LinearLayout(activity);list.setOrientation(android.widget.LinearLayout.VERTICAL);scroll.addView(list);box.addView(scroll,new android.widget.LinearLayout.LayoutParams(-1,Math.min((int)(activity.getResources().getDisplayMetrics().density*240),Math.max(0,a.length()*(int)(activity.getResources().getDisplayMetrics().density*44)))));
        for(int i=0;i<a.length();i++){JSONObject o=a.optJSONObject(i);if(o==null)continue;android.widget.TextView row=new android.widget.TextView(activity);row.setText(o.optString("name")+(o.optString("id").equals(prefs.getString(SELECTED,""))?"  ✓":""));row.setTextColor(fg);row.setTextSize(15);row.setGravity(android.view.Gravity.CENTER_VERTICAL);row.setPadding(d,0,d,0);list.addView(row,new android.widget.LinearLayout.LayoutParams(-1,(int)(activity.getResources().getDisplayMetrics().density*44)));row.setOnClickListener(v->{selectProfile(o.optString("id"));popup.dismiss();changed.run();});}
        android.widget.TextView settings=new android.widget.TextView(activity);settings.setText("⚙  模型设置");settings.setTextColor(fg);settings.setTextSize(15);settings.setGravity(android.view.Gravity.CENTER_VERTICAL);settings.setPadding(d,0,d,0);box.addView(settings,new android.widget.LinearLayout.LayoutParams(-1,(int)(activity.getResources().getDisplayMetrics().density*48)));settings.setOnClickListener(v->{popup.dismiss();showManager(changed);});
        box.measure(android.view.View.MeasureSpec.makeMeasureSpec((int)(activity.getResources().getDisplayMetrics().density*260),android.view.View.MeasureSpec.EXACTLY),android.view.View.MeasureSpec.makeMeasureSpec(0,android.view.View.MeasureSpec.UNSPECIFIED));int[] loc=new int[2];anchor.getLocationOnScreen(loc);int x=Math.max(0,Math.min(loc[0],activity.getResources().getDisplayMetrics().widthPixels-box.getMeasuredWidth()));int y=Math.max(0,loc[1]-box.getMeasuredHeight());popup.showAtLocation(anchor,android.view.Gravity.TOP|android.view.Gravity.LEFT,x,y);
    }
    void showManager(Runnable changed) {
        activity.startActivity(new android.content.Intent(activity,ModelSettingsActivity.class));
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
