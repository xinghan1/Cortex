package com.cortex.mobile;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import android.text.Editable;
import android.text.TextWatcher;
import android.view.Gravity;
import android.view.View;
import android.view.inputmethod.InputMethodManager;
import android.widget.*;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.security.cert.X509Certificate;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;

public class MainActivity extends Activity {
    private static final int BG = 0xff101521, PANEL = 0xff1c2638, TEXT = 0xffedf2ff, MUTED = 0xffa5b4cc, ACCENT = 0xff96b7ff;
    private SharedPreferences prefs;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final ExecutorService remoteWorker = Executors.newFixedThreadPool(3);
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable pollTask = this::poll;
    private LinearLayout messages, remoteControls, remoteProgress;
    private ScrollView scroll;
    private EditText input;
    private TextView status, title;
    private boolean remote = false, busy = false, destroyed = false, polling = false;
    private boolean remoteRunning = false, controlBusy = false;
    private String lastRemoteMessages = "", lastRemoteProgress = "";
    private JSONArray localMessages = new JSONArray();

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        prefs = getSharedPreferences("cortex", MODE_PRIVATE);
        try { localMessages = new JSONArray(prefs.getString("messages", "[]")); } catch (Exception ignored) { localMessages = new JSONArray(); }
        remote=prefs.getBoolean("remote_mode",false); build(); input.setText(prefs.getString(remote?"draft_remote":"draft_local", "")); refreshMode();
    }
    private int dp(int n) { return (int)(n * getResources().getDisplayMetrics().density + 0.5f); }
    private GradientDrawable rounded(int color, int radius) { GradientDrawable d = new GradientDrawable(); d.setColor(color); d.setCornerRadius(dp(radius)); return d; }
    private TextView text(String value, int size, int color) { TextView t = new TextView(this); t.setText(value); t.setTextSize(size); t.setTextColor(color); return t; }
    private Button button(String value) { Button b = new Button(this); b.setText(value); b.setAllCaps(false); b.setTextColor(TEXT); b.setBackground(rounded(PANEL, 12)); return b; }
    private void build() {
        LinearLayout root = new LinearLayout(this); root.setOrientation(LinearLayout.VERTICAL); root.setPadding(dp(16),dp(12),dp(16),dp(12)); root.setBackgroundColor(BG); setContentView(root);
        LinearLayout top = new LinearLayout(this); top.setGravity(Gravity.CENTER_VERTICAL); root.addView(top);
        title = text("Cortex", 23, TEXT); title.setTypeface(null, Typeface.BOLD); top.addView(title, new LinearLayout.LayoutParams(0, -2, 1));
        Button mode = button("切换模式"); top.addView(mode); mode.setOnClickListener(v -> new AlertDialog.Builder(this).setTitle("会话位置").setItems(new String[]{"手机本地会话", "连接电脑"}, (d, which) -> { prefs.edit().putString(remote?"draft_remote":"draft_local",input.getText().toString()).apply(); remote = which == 1; prefs.edit().putBoolean("remote_mode",remote).apply(); input.setText(prefs.getString(remote?"draft_remote":"draft_local", "")); refreshMode(); }).show());
        Button config = button("设置"); LinearLayout.LayoutParams cp = new LinearLayout.LayoutParams(-2,-2); cp.leftMargin=dp(8); top.addView(config,cp); config.setOnClickListener(v -> settings());
        status = text("手机本地会话", 13, MUTED); status.setPadding(0,dp(10),0,dp(8)); root.addView(status);
        remoteControls = new LinearLayout(this); remoteControls.setOrientation(LinearLayout.VERTICAL); root.addView(remoteControls);
        scroll = new ScrollView(this); scroll.setFillViewport(false); root.addView(scroll, new LinearLayout.LayoutParams(-1,0,1));
        LinearLayout feed = new LinearLayout(this); feed.setOrientation(LinearLayout.VERTICAL); scroll.addView(feed);
        messages = new LinearLayout(this); messages.setOrientation(LinearLayout.VERTICAL); feed.addView(messages);
        remoteProgress = new LinearLayout(this); remoteProgress.setOrientation(LinearLayout.VERTICAL); feed.addView(remoteProgress);
        LinearLayout composer = new LinearLayout(this); composer.setGravity(Gravity.BOTTOM); composer.setPadding(0,dp(10),0,0); root.addView(composer);
        input = new EditText(this); input.setTextColor(TEXT); input.setHintTextColor(MUTED); input.setHint("输入消息…"); input.setTextSize(16); input.setMinLines(1); input.setMaxLines(5); input.setPadding(dp(14),dp(10),dp(14),dp(10)); input.setBackground(rounded(PANEL,14)); composer.addView(input,new LinearLayout.LayoutParams(0,-2,1));
        input.addTextChangedListener(new TextWatcher() { public void beforeTextChanged(CharSequence s,int start,int count,int after) {} public void onTextChanged(CharSequence s,int start,int before,int count) { prefs.edit().putString(remote?"draft_remote":"draft_local",s.toString()).apply(); } public void afterTextChanged(Editable e) {} });
        Button send = button("发送"); LinearLayout.LayoutParams sp = new LinearLayout.LayoutParams(-2,-2); sp.leftMargin=dp(8); composer.addView(send,sp); send.setOnClickListener(v -> send());
        Button clear = button("新建手机会话"); root.addView(clear); clear.setOnClickListener(v -> { if(busy) { toast("请等待当前任务结束"); return; } new AlertDialog.Builder(this).setMessage("开始新的手机本地会话？当前本地消息将被清除。").setPositiveButton("新建", (d,w) -> { localMessages=new JSONArray(); saveMessages(); if(!remote) renderLocal(); }).setNegativeButton("取消",null).show(); });
    }
    private void refreshMode() { handler.removeCallbacks(pollTask); title.setText(remote ? "电脑会话" : "Cortex"); remoteProgress.removeAllViews(); lastRemoteProgress=""; if(remote) { lastRemoteMessages=""; messages.removeAllViews(); poll(); } else { remoteControls.removeAllViews(); status.setText("手机本地会话 · 消息保存在本机"); renderLocal(); } }
    private void renderLocal() { render(localMessages); }
    private void render(JSONArray rows) {
        boolean atBottom = isAtBottom(); int oldScroll=scroll.getScrollY(); messages.removeAllViews();
        if (rows.length() == 0) { TextView empty=text(remote ? "电脑会话暂无消息" : "开始一个新会话\n在设置中连接模型后即可发送消息",16,MUTED); empty.setGravity(Gravity.CENTER); empty.setPadding(dp(20),dp(80),dp(20),0); messages.addView(empty); return; }
        for (int i=0;i<rows.length();i++) { JSONObject m=rows.optJSONObject(i); if(m==null) continue; String role=m.optString("role"); if(role.equals("tool")) { TextView event=text("手机文件操作已返回 · "+m.optString("content"),13,MUTED); event.setTextIsSelectable(true); event.setPadding(dp(12),dp(4),dp(12),dp(10)); messages.addView(event); continue; } if(!role.equals("user")&&!role.equals("assistant")) continue; if(role.equals("assistant") && (m.isNull("content") || m.optString("content").isEmpty())) continue;
            LinearLayout box=new LinearLayout(this); box.setOrientation(LinearLayout.VERTICAL); box.setPadding(dp(14),dp(12),dp(14),dp(12)); box.setBackground(rounded(role.equals("user")?0xff263b62:PANEL,14));
            TextView who=text(role.equals("user")?"你":"Cortex",13,ACCENT); who.setTypeface(null,Typeface.BOLD); box.addView(who); TextView body=text(m.optString("content"),16,TEXT); body.setTextIsSelectable(true); body.setPadding(0,dp(6),0,0); box.addView(body);
            LinearLayout.LayoutParams p=new LinearLayout.LayoutParams(-1,-2); p.bottomMargin=dp(10); messages.addView(box,p);
        } restoreScroll(atBottom,oldScroll);
    }
    private boolean isAtBottom() { return scroll.getChildCount()==0 || scroll.getScrollY()+scroll.getHeight()>=scroll.getChildAt(0).getHeight()-dp(60); }
    private void restoreScroll(boolean atBottom,int oldScroll) { scroll.post(() -> { if(atBottom) scroll.fullScroll(View.FOCUS_DOWN); else scroll.scrollTo(0,oldScroll); }); }
    private void saveMessages() { prefs.edit().putString("messages",localMessages.toString()).apply(); }
    private void send() {
        String prompt=input.getText().toString().trim(); if(prompt.isEmpty()||busy) return;
        final boolean wasRemote=remote; final String endpoint=prefs.getString(wasRemote?"remote_url":"api_url", "").trim(); final String secret;
        try { secret=readSecret(wasRemote?"remote_token":"api_key"); validateUrl(endpoint,wasRemote); if(secret.isEmpty()) throw new Exception("请先在设置中填写密钥或配对令牌。"); if(!wasRemote && prefs.getString("model", "").trim().isEmpty()) throw new Exception("请先设置模型名称。"); }
        catch(Exception ex) { toast(ex.getMessage()); return; }
        input.setText(""); busy=true; status.setText(wasRemote?"正在发送到电脑…":"正在请求模型…");
        if(!wasRemote) { try { localMessages.put(new JSONObject().put("role","user").put("content",prompt)); } catch(Exception ignored) {} saveMessages(); renderLocal(); }
        final String model=prefs.getString("model", "").trim(); final String snapshot=localMessages.toString();
        (wasRemote ? remoteWorker : worker).execute(() -> { try {
            if(wasRemote) { request(endpoint,"/v1/messages",secret,new JSONObject().put("text",prompt),true); runOnUiThread(() -> { busy=false; if(remote) poll(); }); }
            else { JSONArray conversation=new JSONArray(snapshot); FolderTools folder=new FolderTools(this,prefs.getString("folder_uri","")); boolean done=false;
                for(int turn=0;turn<12;turn++) { JSONObject data=new JSONObject().put("model",model).put("messages",conversation).put("stream",false).put("tools",FolderTools.definitions()); JSONObject response=request(endpoint,"/chat/completions",secret,data,false); JSONObject reply=response.getJSONArray("choices").getJSONObject(0).getJSONObject("message"); JSONArray calls=reply.optJSONArray("tool_calls"); if(calls==null||calls.length()==0) { conversation.put(new JSONObject().put("role","assistant").put("content",reply.optString("content",""))); done=true; break; }
                    conversation.put(reply); for(int i=0;i<calls.length();i++) { JSONObject call=calls.getJSONObject(i), f=call.getJSONObject("function"); String result; try { result=folder.call(f.getString("name"),new JSONObject(f.optString("arguments","{}"))); } catch(Exception e) { result=new JSONObject().put("error",String.valueOf(e.getMessage())).toString(); } conversation.put(new JSONObject().put("role","tool").put("tool_call_id",call.getString("id")).put("content",result)); }
                    JSONArray progress=new JSONArray(conversation.toString()); runOnUiThread(() -> { localMessages=progress; saveMessages(); if(!remote) { renderLocal(); status.setText("正在处理手机文件…"); } });
                } if(!done) conversation.put(new JSONObject().put("role","assistant").put("content","任务已暂停：工具调用次数达到上限，请发送消息继续。")); JSONArray completed=conversation; runOnUiThread(() -> { localMessages=completed; saveMessages(); if(!remote) { renderLocal(); status.setText("手机本地会话 · 消息保存在本机"); } busy=false; }); }
        } catch(Exception ex) { runOnUiThread(() -> { busy=false; if(wasRemote) { String draft=prefs.getString("draft_remote",""); if(draft.isEmpty()) { prefs.edit().putString("draft_remote",prompt).apply(); if(remote && input.length()==0) input.setText(prompt); } } if(remote==wasRemote) status.setText("发送失败："+ex.getMessage()); toast("发送失败，请检查连接与设置"); }); } });
    }
    private void poll() {
        if(!remote||polling||destroyed) return; final String endpoint=prefs.getString("remote_url", "").trim(); final String token;
        try { validateUrl(endpoint,true); token=readSecret("remote_token"); if(token.isEmpty()) throw new Exception("请在设置中填写电脑配对令牌"); } catch(Exception ex) { status.setText(ex.getMessage()); return; }
        polling=true; remoteWorker.execute(() -> { try { JSONObject result=request(endpoint,"/v1/state",token,null,true); runOnUiThread(() -> { polling=false; if(remote&&!destroyed) { JSONArray rows=result.optJSONArray("messages") == null ? new JSONArray() : result.optJSONArray("messages"); String key=rows.toString(); if(!key.equals(lastRemoteMessages)) { lastRemoteMessages=key; render(rows); } remoteRunning=result.optBoolean("running"); renderRemoteProgress(result.optJSONArray("operations"),result.optString("streamText","")); renderRemoteControls(result.optJSONArray("pendingApprovals")); status.setText((remoteRunning?"电脑正在执行":"已连接电脑")+" · "+result.optString("title","会话")); handler.removeCallbacks(pollTask); handler.postDelayed(pollTask,2000); } }); }
        catch(Exception ex) { runOnUiThread(() -> { polling=false; if(remote&&!destroyed) { remoteControls.removeAllViews(); status.setText("电脑连接失败："+ex.getMessage()); handler.removeCallbacks(pollTask); handler.postDelayed(pollTask,5000); } }); } });
    }
    private void renderRemoteProgress(JSONArray operations,String stream) {
        if(operations==null) operations=new JSONArray(); String signature=operations.toString()+"\n"+stream; if(signature.equals(lastRemoteProgress)) return; lastRemoteProgress=signature;
        boolean atBottom=isAtBottom(); int oldScroll=scroll.getScrollY(); remoteProgress.removeAllViews();
        for(int i=0;i<operations.length();i++) { JSONObject operation=operations.optJSONObject(i); if(operation==null) continue; String kind=operation.optString("type"), name=operation.optString("name","工具"); if(!kind.equals("tool-start")&&!kind.equals("tool-result")) continue; TextView row=text((kind.equals("tool-start")?"调用工具 · ":"工具返回 · ")+name,13,MUTED); row.setPadding(dp(12),dp(5),dp(12),dp(5)); remoteProgress.addView(row); }
        if(!stream.isEmpty()) { LinearLayout box=new LinearLayout(this); box.setOrientation(LinearLayout.VERTICAL); box.setPadding(dp(14),dp(12),dp(14),dp(12)); box.setBackground(rounded(PANEL,14)); TextView label=text("Cortex · 正在回复",13,ACCENT); label.setTypeface(null,Typeface.BOLD); box.addView(label); TextView body=text(stream,16,TEXT); body.setTextIsSelectable(true); body.setPadding(0,dp(6),0,0); box.addView(body); remoteProgress.addView(box); } restoreScroll(atBottom,oldScroll);
    }
    private void renderRemoteControls(JSONArray approvals) {
        remoteControls.removeAllViews();
        if(approvals!=null) for(int i=0;i<approvals.length();i++) { JSONObject approval=approvals.optJSONObject(i); if(approval==null||approval.optString("id").isEmpty()) continue; String id=approval.optString("id"); Button review=button("需要审批 · 点击查看完整详情"); remoteControls.addView(review); review.setOnClickListener(v -> {
            String details; try { details=approval.toString(2); } catch(Exception ignored) { details=approval.toString(); }
            new AlertDialog.Builder(this).setTitle("电脑操作审批").setMessage(details).setPositiveButton("批准",(dialog,which) -> new AlertDialog.Builder(this).setMessage("确认批准这项电脑操作？").setPositiveButton("确认批准",(d,w)->approve(id,true)).setNegativeButton("取消",null).show()).setNegativeButton("拒绝",(dialog,which)->approve(id,false)).setNeutralButton("稍后",null).show();
        }); }
        if(remoteRunning) { Button stop=button("停止电脑任务"); remoteControls.addView(stop); stop.setOnClickListener(v -> new AlertDialog.Builder(this).setMessage("确定停止电脑当前任务？").setPositiveButton("停止任务",(d,w)->sendControl("/v1/stop",new JSONObject())).setNegativeButton("取消",null).show()); }
    }
    private void approve(String id,boolean approved) { try { sendControl("/v1/approval",new JSONObject().put("id",id).put("approved",approved)); } catch(Exception e) { toast("审批失败："+e.getMessage()); } }
    private void sendControl(String route,JSONObject body) {
        if(controlBusy) { toast("正在处理上一项操作"); return; } final String endpoint=prefs.getString("remote_url","").trim(), token;
        try { validateUrl(endpoint,true); token=readSecret("remote_token"); if(token.isEmpty()) throw new Exception("请先填写配对令牌"); } catch(Exception e) { toast(e.getMessage()); return; }
        controlBusy=true; remoteWorker.execute(() -> { try { request(endpoint,route,token,body,true); runOnUiThread(() -> { controlBusy=false; toast("操作已发送"); handler.removeCallbacks(pollTask); poll(); }); } catch(Exception e) { runOnUiThread(() -> { controlBusy=false; toast("操作失败："+e.getMessage()); }); } });
    }
    private JSONObject request(String base,String route,String token,JSONObject body,boolean computer) throws Exception {
        String url=base.replaceAll("/+$", "")+route; HttpURLConnection c=(HttpURLConnection)new URL(url).openConnection(); c.setConnectTimeout(15000); c.setReadTimeout(body==null?15000:120000); c.setInstanceFollowRedirects(false); c.setRequestProperty("Authorization","Bearer "+token); c.setRequestProperty("Accept","application/json");
        if(computer) { String fingerprint=prefs.getString("remote_fingerprint","").replace(":","").replace(" ","").toLowerCase(java.util.Locale.ROOT); if(!fingerprint.matches("[0-9a-f]{64}")) throw new Exception("请填写电脑显示的 SHA-256 证书指纹"); SSLContext context=SSLContext.getInstance("TLS"); context.init(null,new TrustManager[]{new X509TrustManager() { public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; } public void checkClientTrusted(X509Certificate[] chain,String auth) throws java.security.cert.CertificateException { throw new java.security.cert.CertificateException("不支持客户端证书"); } public void checkServerTrusted(X509Certificate[] chain,String auth) throws java.security.cert.CertificateException { try { if(chain==null || chain.length==0) throw new Exception(); byte[] hash=MessageDigest.getInstance("SHA-256").digest(chain[0].getEncoded()); StringBuilder s=new StringBuilder(); for(byte b:hash) s.append(String.format(java.util.Locale.ROOT,"%02x",b&255)); if(!MessageDigest.isEqual(s.toString().getBytes(StandardCharsets.US_ASCII),fingerprint.getBytes(StandardCharsets.US_ASCII))) throw new Exception(); } catch(Exception e) { throw new java.security.cert.CertificateException("电脑证书指纹不匹配"); } } }},null); HttpsURLConnection https=(HttpsURLConnection)c; https.setSSLSocketFactory(context.getSocketFactory()); https.setHostnameVerifier((host,session)->true); }
        try { if(body!=null) { c.setRequestMethod("POST"); c.setDoOutput(true); c.setRequestProperty("Content-Type","application/json; charset=utf-8"); try(OutputStream out=c.getOutputStream()) { out.write(body.toString().getBytes(StandardCharsets.UTF_8)); } }
            int code=c.getResponseCode(); if(code<200||code>=300) throw new Exception("HTTP "+code); try(InputStream in=c.getInputStream(); ByteArrayOutputStream out=new ByteArrayOutputStream()) { byte[] b=new byte[8192]; int n; while((n=in.read(b))!=-1) { if(out.size()+n>4_000_000) throw new Exception("响应过大"); out.write(b,0,n); } return new JSONObject(out.toString("UTF-8")); }
        } finally { c.disconnect(); }
    }
    private void validateUrl(String value,boolean computer) throws Exception {
        URL u=new URL(value); if(u.getUserInfo()!=null || u.getQuery()!=null || u.getRef()!=null) throw new Exception("地址格式不正确");
        if(!"https".equalsIgnoreCase(u.getProtocol())) throw new Exception("连接地址须使用 HTTPS");
        if(u.getHost()==null || u.getHost().isEmpty()) throw new Exception("连接地址缺少主机名");
    }
    private EditText field(LinearLayout layout,String hint,String value,boolean secret) { EditText e=new EditText(this); e.setHint(hint); e.setText(value); if(secret) e.setInputType(129); layout.addView(e); return e; }
    private void settings() {
        LinearLayout form=new LinearLayout(this); form.setOrientation(LinearLayout.VERTICAL); form.setPadding(dp(20),0,dp(20),0);
        EditText api=field(form,"模型 API 根地址（如 https://example.com/v1）",prefs.getString("api_url",""),false), model=field(form,"模型名称",prefs.getString("model",""),false), key=field(form,"API 密钥（留空保持原值）","",true), computer=field(form,"电脑地址（如 https://192.168.1.2:端口）",prefs.getString("remote_url",""),false), fingerprint=field(form,"电脑证书 SHA-256 指纹",prefs.getString("remote_fingerprint",""),false), token=field(form,"电脑配对令牌（留空保持原值）","",true);
        Button folder=button("选择手机文件夹（授权 AI 读取和修改）"); form.addView(folder); folder.setOnClickListener(v -> { Intent intent=new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE); intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION|Intent.FLAG_GRANT_WRITE_URI_PERMISSION|Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION); startActivityForResult(intent,41); });
        ScrollView s=new ScrollView(this); s.addView(form); new AlertDialog.Builder(this).setTitle("连接设置").setView(s).setPositiveButton("保存", (d,w)-> { try { if(!api.getText().toString().trim().isEmpty()) validateUrl(api.getText().toString().trim(),false); if(!computer.getText().toString().trim().isEmpty()) validateUrl(computer.getText().toString().trim(),true); String fp=fingerprint.getText().toString().replace(":","").replace(" ",""); if(!fp.isEmpty()&&!fp.matches("(?i)[0-9a-f]{64}")) throw new Exception("证书指纹必须为 64 位十六进制字符"); if(key.length()>0) writeSecret("api_key",key.getText().toString()); if(token.length()>0) writeSecret("remote_token",token.getText().toString()); prefs.edit().putString("api_url",api.getText().toString().trim()).putString("model",model.getText().toString().trim()).putString("remote_url",computer.getText().toString().trim()).putString("remote_fingerprint",fp).apply(); if(remote) poll(); toast("设置已保存"); } catch(Exception ex) { toast("设置未保存："+ex.getMessage()); } }).setNegativeButton("取消",null).show();
    }
    @Override protected void onActivityResult(int requestCode,int resultCode,Intent data) { super.onActivityResult(requestCode,resultCode,data); if(requestCode==41&&resultCode==RESULT_OK&&data!=null&&data.getData()!=null) { Uri uri=data.getData(); int flags=data.getFlags() & (Intent.FLAG_GRANT_READ_URI_PERMISSION|Intent.FLAG_GRANT_WRITE_URI_PERMISSION); if(flags!=(Intent.FLAG_GRANT_READ_URI_PERMISSION|Intent.FLAG_GRANT_WRITE_URI_PERMISSION)) { toast("请选择允许读取和写入的文件夹"); return; } try { getContentResolver().takePersistableUriPermission(uri,flags); prefs.edit().putString("folder_uri",uri.toString()).apply(); toast("文件夹已授权"); } catch(Exception e) { toast("文件夹授权失败"); } } }
    private SecretKey key() throws Exception { KeyStore ks=KeyStore.getInstance("AndroidKeyStore"); ks.load(null); if(!ks.containsAlias("cortex_secrets")) { KeyGenerator g=KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES,"AndroidKeyStore"); g.init(new KeyGenParameterSpec.Builder("cortex_secrets",KeyProperties.PURPOSE_ENCRYPT|KeyProperties.PURPOSE_DECRYPT).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build()); g.generateKey(); } return (SecretKey)ks.getKey("cortex_secrets",null); }
    private void writeSecret(String name,String value) throws Exception { Cipher c=Cipher.getInstance("AES/GCM/NoPadding"); c.init(Cipher.ENCRYPT_MODE,key()); byte[] encrypted=c.doFinal(value.getBytes(StandardCharsets.UTF_8)); prefs.edit().putString(name,Base64.encodeToString(c.getIV(),Base64.NO_WRAP)+":"+Base64.encodeToString(encrypted,Base64.NO_WRAP)).apply(); }
    private String readSecret(String name) throws Exception { String v=prefs.getString(name,""); if(v.isEmpty()) return ""; String[] p=v.split(":",2); Cipher c=Cipher.getInstance("AES/GCM/NoPadding"); c.init(Cipher.DECRYPT_MODE,key(),new GCMParameterSpec(128,Base64.decode(p[0],Base64.NO_WRAP))); return new String(c.doFinal(Base64.decode(p[1],Base64.NO_WRAP)),StandardCharsets.UTF_8); }
    private void toast(String s) { Toast.makeText(this,s,Toast.LENGTH_LONG).show(); }
    @Override protected void onDestroy() { destroyed=true; handler.removeCallbacksAndMessages(null); worker.shutdownNow(); remoteWorker.shutdownNow(); super.onDestroy(); }
}
