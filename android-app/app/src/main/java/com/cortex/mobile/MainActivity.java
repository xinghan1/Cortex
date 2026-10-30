package com.cortex.mobile;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.Dialog;
import android.view.Window;
import android.view.WindowManager;
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
    private int BG = 0xff101113, PANEL = 0xff242528, TEXT = 0xfff2f2f3, MUTED = 0xff95979d, ACCENT = 0xffaec5f5;
    private boolean light;
    private ModelStore modelStore;
    private SessionStore sessionStore;
    // A request may outlive an Activity recreation. Share the store and lease
    // for the process lifetime so an old callback cannot overwrite newer chats.
    private static SessionStore sharedSessionStore;
    private static volatile boolean busy;
    private static java.lang.ref.WeakReference<MainActivity> activeActivity = new java.lang.ref.WeakReference<>(null);
    private TextView modelButton, chatTab, computerTab;
    private String remoteModel="";
    private SharedPreferences prefs;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final ExecutorService remoteWorker = Executors.newFixedThreadPool(3);
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable pollTask = this::poll;
    private LinearLayout messages, remoteControls, remoteProgress;
    private ScrollView scroll;
    private EditText input;
    private TextView status, title;
    private boolean remote = false, destroyed = false, polling = false;
    private boolean remoteRunning = false, controlBusy = false;
    private String lastRemoteMessages = "", lastRemoteProgress = "";
    private JSONArray localMessages = new JSONArray();

    @Override public void onCreate(Bundle state) {
        light = getSharedPreferences("cortex", MODE_PRIVATE).getBoolean("light_theme", false);
        setTheme(light ? android.R.style.Theme_Material_Light_NoActionBar : android.R.style.Theme_Material_NoActionBar);
        super.onCreate(state);
        if(light) { BG=0xfff7f7f8; PANEL=0xffe9eaed; TEXT=0xff181a1f; MUTED=0xff70747d; ACCENT=0xff4569ac; }
        getWindow().setStatusBarColor(BG); getWindow().setNavigationBarColor(BG);
        if(light) getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
        prefs = getSharedPreferences("cortex", MODE_PRIVATE);
        modelStore = new ModelStore(this,prefs);
        if(sharedSessionStore == null) sharedSessionStore = new SessionStore(getApplicationContext(),prefs);
        sessionStore = sharedSessionStore;
        activeActivity = new java.lang.ref.WeakReference<>(this);
        localMessages = sessionStore.load(sessionStore.currentId());
        remote=prefs.getBoolean("remote_mode",false); build(); input.setText(prefs.getString(remote?"draft_remote":"draft_local", "")); refreshMode(); if(busy) status.setText("任务仍在执行，请等待完成");
    }
    private int dp(int n) { return (int)(n * getResources().getDisplayMetrics().density + 0.5f); }
    private GradientDrawable rounded(int color, int radius) { GradientDrawable d = new GradientDrawable(); d.setColor(color); d.setCornerRadius(dp(radius)); return d; }
    private TextView text(String value, int size, int color) { TextView t = new TextView(this); t.setText(value); t.setTextSize(size); t.setTextColor(color); return t; }
    private Button button(String value) { Button b = new Button(this); b.setText(value); b.setAllCaps(false); b.setTextColor(TEXT); b.setBackground(rounded(PANEL, 12)); return b; }
    private TextView control(String value, int size) { TextView v=text(value,size,TEXT); v.setGravity(Gravity.CENTER); v.setBackground(rounded(PANEL,24)); return v; }
    private void changeMode(boolean next) {
        if(remote==next) return;
        prefs.edit().putString(remote?"draft_remote":"draft_local",input.getText().toString()).apply();
        remote=next; prefs.edit().putBoolean("remote_mode",remote).apply();
        input.setText(prefs.getString(remote?"draft_remote":"draft_local", "")); refreshMode();
    }
    private void refreshTabs() {
        chatTab.setBackground(rounded(remote ? PANEL : (light?0xffffffff:0xff111214),22));
        computerTab.setBackground(rounded(remote ? (light?0xffffffff:0xff111214) : PANEL,22));
        modelButton.setText(remote ? (remoteModel.isEmpty()?"电脑模型":remoteModel) : modelStore.selectedName());
        modelButton.setEnabled(true);
    }
    private void build() {
        LinearLayout root = new LinearLayout(this); root.setOrientation(LinearLayout.VERTICAL); root.setPadding(dp(14),dp(12),dp(14),dp(10)); root.setBackgroundColor(BG); setContentView(root);
        android.widget.FrameLayout top=new android.widget.FrameLayout(this); root.addView(top,new LinearLayout.LayoutParams(-1,dp(50)));
        TextView menu=control("☰",22); android.widget.FrameLayout.LayoutParams left=new android.widget.FrameLayout.LayoutParams(dp(46),dp(46),Gravity.START|Gravity.CENTER_VERTICAL); top.addView(menu,left); menu.setContentDescription("会话历史"); menu.setOnClickListener(v->showHistory());
        LinearLayout tabs=new LinearLayout(this); tabs.setPadding(dp(4),dp(4),dp(4),dp(4)); tabs.setBackground(rounded(PANEL,28)); android.widget.FrameLayout.LayoutParams middle=new android.widget.FrameLayout.LayoutParams(Math.min(dp(210),Math.max(dp(140),getResources().getDisplayMetrics().widthPixels-dp(148))),dp(46),Gravity.CENTER); top.addView(tabs,middle);
        chatTab=control("对话",15); computerTab=control("连接电脑",15); tabs.addView(chatTab,new LinearLayout.LayoutParams(0,-1,1)); tabs.addView(computerTab,new LinearLayout.LayoutParams(0,-1,1)); chatTab.setOnClickListener(v->changeMode(false)); computerTab.setOnClickListener(v->changeMode(true));
        TextView config=control("⚙",21); android.widget.FrameLayout.LayoutParams right=new android.widget.FrameLayout.LayoutParams(dp(46),dp(46),Gravity.END|Gravity.CENTER_VERTICAL); top.addView(config,right); config.setContentDescription("设置"); config.setOnClickListener(v->settings());
        title=text("Cortex",14,TEXT); title.setVisibility(View.GONE);
        status=text("手机本地会话",12,MUTED); status.setGravity(Gravity.CENTER); status.setPadding(0,dp(6),0,dp(2)); root.addView(status);
        remoteControls=new LinearLayout(this); remoteControls.setOrientation(LinearLayout.VERTICAL); root.addView(remoteControls);
        scroll=new ScrollView(this); scroll.setFillViewport(true); scroll.setClipToPadding(false); root.addView(scroll,new LinearLayout.LayoutParams(-1,0,1));
        LinearLayout feed=new LinearLayout(this); feed.setOrientation(LinearLayout.VERTICAL); scroll.addView(feed); messages=new LinearLayout(this); messages.setOrientation(LinearLayout.VERTICAL); feed.addView(messages); remoteProgress=new LinearLayout(this); remoteProgress.setOrientation(LinearLayout.VERTICAL); feed.addView(remoteProgress);
        LinearLayout composer=new LinearLayout(this); composer.setOrientation(LinearLayout.VERTICAL); composer.setPadding(dp(14),dp(6),dp(8),dp(8)); composer.setBackground(rounded(PANEL,24)); root.addView(composer);
        input=new EditText(this); input.setTextColor(TEXT); input.setHintTextColor(MUTED); input.setHint("输入消息，开始对话…"); input.setTextSize(16); input.setMinLines(1); input.setMaxLines(5); input.setPadding(dp(2),dp(8),dp(2),dp(8)); input.setBackgroundColor(Color.TRANSPARENT); composer.addView(input,new LinearLayout.LayoutParams(-1,-2));
        input.addTextChangedListener(new TextWatcher() { public void beforeTextChanged(CharSequence s,int start,int count,int after) {} public void onTextChanged(CharSequence s,int start,int before,int count) { prefs.edit().putString(remote?"draft_remote":"draft_local",s.toString()).apply(); } public void afterTextChanged(Editable e) {} });
        LinearLayout actions=new LinearLayout(this); actions.setGravity(Gravity.CENTER_VERTICAL); composer.addView(actions,new LinearLayout.LayoutParams(-1,dp(38)));
        TextView folder=control("＋",24); folder.setBackgroundColor(Color.TRANSPARENT); folder.setContentDescription("选择手机文件夹"); actions.addView(folder,new LinearLayout.LayoutParams(dp(38),dp(38))); folder.setOnClickListener(v->chooseFolder());
        View spacer=new View(this); actions.addView(spacer,new LinearLayout.LayoutParams(0,1,1));
        modelButton=control("选择模型  ▾",13); modelButton.setPadding(dp(12),0,dp(12),0); modelButton.setMaxWidth(dp(140)); modelButton.setSingleLine(true); modelButton.setEllipsize(android.text.TextUtils.TruncateAt.END); modelButton.setBackground(rounded(light?0xffdfe2e8:0xff36383c,18)); actions.addView(modelButton,new LinearLayout.LayoutParams(-2,dp(34))); modelButton.setOnClickListener(v->showModelSelector());
        TextView send=control("↑",23); send.setTextColor(light?Color.WHITE:0xff111214); send.setBackground(rounded(light?0xff252a35:0xfff1f2f5,22)); LinearLayout.LayoutParams sp=new LinearLayout.LayoutParams(dp(38),dp(38)); sp.leftMargin=dp(8); actions.addView(send,sp); send.setContentDescription("发送消息"); send.setOnClickListener(v->send());
    }
    private void chooseFolder() { Intent intent=new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE); intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION|Intent.FLAG_GRANT_WRITE_URI_PERMISSION|Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION); startActivityForResult(intent,41); }
    private void showHistory() {
        Dialog drawer=new Dialog(this); LinearLayout panel=new LinearLayout(this); panel.setOrientation(LinearLayout.VERTICAL); panel.setPadding(dp(18),dp(20),dp(18),dp(18)); panel.setBackgroundColor(light?0xfff0f1f3:0xff101113);
        LinearLayout head=new LinearLayout(this); head.setGravity(Gravity.CENTER_VERTICAL); panel.addView(head); TextView brand=text("Cortex",23,TEXT); brand.setTypeface(null,Typeface.BOLD); head.addView(brand,new LinearLayout.LayoutParams(0,-2,1)); TextView close=control("×",24); head.addView(close,new LinearLayout.LayoutParams(dp(40),dp(40))); close.setOnClickListener(v->drawer.dismiss());
        EditText search=new EditText(this); search.setSingleLine(true); search.setTextColor(TEXT); search.setHintTextColor(MUTED); search.setHint("搜索对话内容…"); search.setTextSize(15); search.setPadding(dp(16),0,dp(16),0); search.setBackground(rounded(PANEL,24)); LinearLayout.LayoutParams searchParams=new LinearLayout.LayoutParams(-1,dp(48)); searchParams.topMargin=dp(24); panel.addView(search,searchParams);
        TextView newChat=control("＋  新建对话",15); newChat.setGravity(Gravity.CENTER_VERTICAL|Gravity.START); newChat.setPadding(dp(14),0,0,0); LinearLayout.LayoutParams np=new LinearLayout.LayoutParams(-1,dp(46)); np.topMargin=dp(18); panel.addView(newChat,np); newChat.setOnClickListener(v->{ if(busy) { toast("请等待当前任务结束"); return; } String id=sessionStore.create(); sessionStore.select(id); localMessages=sessionStore.load(id); changeMode(false); renderLocal(); drawer.dismiss(); });
        TextView label=text("会话历史",13,MUTED); label.setPadding(dp(4),dp(20),0,dp(12)); panel.addView(label);
        ScrollView listScroll=new ScrollView(this); panel.addView(listScroll,new LinearLayout.LayoutParams(-1,0,1)); LinearLayout list=new LinearLayout(this); list.setOrientation(LinearLayout.VERTICAL); listScroll.addView(list);
        Runnable update=()->renderHistory(list,search.getText().toString(),drawer); search.addTextChangedListener(new TextWatcher(){ public void beforeTextChanged(CharSequence s,int start,int count,int after){} public void onTextChanged(CharSequence s,int start,int before,int count){update.run();} public void afterTextChanged(Editable e){} }); update.run();
        TextView models=control("模型与账号设置",14); LinearLayout.LayoutParams mp=new LinearLayout.LayoutParams(-1,dp(44)); mp.topMargin=dp(8); panel.addView(models,mp); models.setOnClickListener(v->{drawer.dismiss(); modelStore.showManager(()->refreshTabs());});
        TextView theme=control(light?"切换深色模式":"切换浅色模式",14); LinearLayout.LayoutParams tp=new LinearLayout.LayoutParams(-1,dp(44)); tp.topMargin=dp(8); panel.addView(theme,tp); theme.setOnClickListener(v->{ if(busy){toast("请等待当前任务结束");return;} prefs.edit().putBoolean("light_theme",!light).apply(); drawer.dismiss(); recreate(); });
        drawer.setContentView(panel); Window window=drawer.getWindow(); if(window!=null){ window.setBackgroundDrawableResource(android.R.color.transparent); window.setLayout(Math.min(dp(320),getResources().getDisplayMetrics().widthPixels-dp(48)),WindowManager.LayoutParams.MATCH_PARENT); window.setGravity(Gravity.START); window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE); } drawer.show(); if(window!=null) window.setLayout(Math.min(dp(320),getResources().getDisplayMetrics().widthPixels-dp(48)),WindowManager.LayoutParams.MATCH_PARENT);
    }
    private void renderHistory(LinearLayout list,String query,Dialog drawer) {
        list.removeAllViews(); JSONArray rows=sessionStore.list(query); if(rows.length()==0){ TextView empty=text("暂无会话",14,MUTED); empty.setPadding(dp(8),dp(20),0,0); list.addView(empty); return; }
        for(int i=0;i<rows.length();i++){ JSONObject row=rows.optJSONObject(i); if(row==null) continue; String id=row.optString("id"), name=row.optString("title","新对话"); TextView item=text(name,16,TEXT); item.setSingleLine(true); item.setEllipsize(android.text.TextUtils.TruncateAt.END); item.setGravity(Gravity.CENTER_VERTICAL); item.setPadding(dp(12),0,dp(12),0); if(id.equals(sessionStore.currentId())) item.setBackground(rounded(PANEL,12)); list.addView(item,new LinearLayout.LayoutParams(-1,dp(52))); item.setOnClickListener(v->{ if(busy){toast("请等待当前任务结束");return;} sessionStore.select(id); localMessages=sessionStore.load(id); changeMode(false); renderLocal(); drawer.dismiss(); }); item.setOnLongClickListener(v->{ if(busy){toast("请等待当前任务结束");return true;} new AlertDialog.Builder(this).setTitle("删除会话？").setMessage(name).setPositiveButton("删除",(d,w)->{sessionStore.delete(id); localMessages=sessionStore.load(sessionStore.currentId()); renderLocal(); renderHistory(list,query,drawer);}).setNegativeButton("取消",null).show(); return true; }); }
    }
    private void refreshMode() { refreshTabs(); handler.removeCallbacks(pollTask); title.setText(remote ? "电脑会话" : "Cortex"); remoteProgress.removeAllViews(); lastRemoteProgress=""; if(remote) { lastRemoteMessages=""; messages.removeAllViews(); poll(); } else { remoteControls.removeAllViews(); status.setText("手机本地会话 · 消息保存在本机"); renderLocal(); } }
    private void renderLocal() { render(localMessages); }
    private void render(JSONArray rows) {
        boolean atBottom = isAtBottom(); int oldScroll=scroll.getScrollY(); messages.removeAllViews();
        if (rows.length() == 0) { TextView empty=text(remote ? "电脑会话暂无消息" : "开始一个新会话\n在设置中连接模型后即可发送消息",16,MUTED); empty.setGravity(Gravity.CENTER); empty.setPadding(dp(20),dp(80),dp(20),0); messages.addView(empty); return; }
        for (int i=0;i<rows.length();i++) { JSONObject m=rows.optJSONObject(i); if(m==null) continue; String role=m.optString("role"); if(role.equals("tool")) { TextView event=text("手机文件操作已返回 · "+m.optString("content"),13,MUTED); event.setTextIsSelectable(true); event.setPadding(dp(12),dp(4),dp(12),dp(10)); messages.addView(event); continue; } if(!role.equals("user")&&!role.equals("assistant")) continue; if(role.equals("assistant") && (m.isNull("content") || m.optString("content").isEmpty())) continue;
            LinearLayout box=new LinearLayout(this); box.setOrientation(LinearLayout.VERTICAL); box.setPadding(dp(14),dp(12),dp(14),dp(12)); box.setBackground(rounded(role.equals("user")?(light?0xffdde6f6:0xff30343b):PANEL,14));
            TextView who=text(role.equals("user")?"你":"Cortex",13,ACCENT); who.setTypeface(null,Typeface.BOLD); box.addView(who); TextView body=text(m.optString("content"),16,TEXT); body.setTextIsSelectable(true); body.setPadding(0,dp(6),0,0); box.addView(body);
            LinearLayout.LayoutParams p=new LinearLayout.LayoutParams(-1,-2); p.bottomMargin=dp(10); messages.addView(box,p);
        } restoreScroll(atBottom,oldScroll);
    }
    private boolean isAtBottom() { return scroll.getChildCount()==0 || scroll.getScrollY()+scroll.getHeight()>=scroll.getChildAt(0).getHeight()-dp(60); }
    private void restoreScroll(boolean atBottom,int oldScroll) { scroll.post(() -> { if(atBottom) scroll.fullScroll(View.FOCUS_DOWN); else scroll.scrollTo(0,oldScroll); }); }
    private void saveMessages() { sessionStore.save(sessionStore.currentId(),localMessages); }
    private void showModelSelector() {
        if(!remote) { modelStore.showSelector(this::refreshTabs); return; }
        final String endpoint=prefs.getString("remote_url","").trim(), token;
        try { validateUrl(endpoint,true); token=readSecret("remote_token"); if(token.isEmpty()) throw new Exception("请先配置电脑连接"); } catch(Exception e) { toast(e.getMessage()); return; }
        remoteWorker.execute(()->{ try {
            JSONObject result=request(endpoint,"/v1/models",token,null,true); JSONArray models=result.optJSONArray("models");
            if(models==null || models.length()==0) throw new Exception("电脑未返回可用模型，请检查电脑的账号或模型配置");
            String[] labels=new String[models.length()]; for(int i=0;i<models.length();i++) { JSONObject m=models.getJSONObject(i); labels[i]=m.optString("name",m.optString("id"))+(m.optBoolean("supportsTools",true)?"":"（不支持工具）"); }
            runOnUiThread(()->{ if(!remote || destroyed) return; new AlertDialog.Builder(this).setTitle("电脑模型").setItems(labels,(dialog,which)->{
                JSONObject m=models.optJSONObject(which); if(m==null) return; if(!m.optBoolean("supportsTools",true)) { toast("此模型不支持工具调用"); return; }
                final String id=m.optString("id"); remoteWorker.execute(()->{ try {
                    JSONObject response=request(endpoint,"/v1/model",token,new JSONObject().put("model",id),true);
                    runOnUiThread(()->{ if(remote&&!destroyed) { remoteModel=response.optString("model",id); refreshTabs(); toast("电脑模型已切换"); } });
                } catch(Exception e) { runOnUiThread(()->toast("切换电脑模型失败："+e.getMessage())); } });
            }).setNegativeButton("取消",null).show(); });
        } catch(Exception e) { runOnUiThread(()->toast("获取电脑模型失败："+e.getMessage())); } });
    }
    private void send() {
        String prompt=input.getText().toString().trim(); if(prompt.isEmpty()) return; if(busy) { toast("任务仍在执行，请等待完成"); return; }
        final boolean wasRemote=remote; final ModelStore chosenModels=new ModelStore(this,prefs); final String endpoint=(wasRemote?prefs.getString("remote_url", ""):chosenModels.selectedUrl()).trim(); final String secret; final String model=chosenModels.selectedModel().trim();
        try { secret=wasRemote?readSecret("remote_token"):chosenModels.selectedKey(); validateUrl(endpoint,wasRemote); if(secret.isEmpty()) throw new Exception("请先配置模型密钥或电脑配对令牌。"); if(!wasRemote && model.isEmpty()) throw new Exception("请先选择模型。"); }
        catch(Exception ex) { toast(ex.getMessage()); return; }
        input.setText(""); busy=true; status.setText(wasRemote?"正在发送到电脑…":"正在请求模型…");
        if(!wasRemote) { try { localMessages.put(new JSONObject().put("role","user").put("content",prompt)); } catch(Exception ignored) {} saveMessages(); renderLocal(); }
        final String snapshot=localMessages.toString(); final String sentSession=sessionStore.currentId();
        (wasRemote ? remoteWorker : worker).execute(() -> { try {
            if(wasRemote) { request(endpoint,"/v1/messages",secret,new JSONObject().put("text",prompt),true); runOnUiThread(() -> { busy=false; MainActivity view=activeActivity.get(); if(view!=null && !view.destroyed && view.remote) view.poll(); }); }
            else { JSONArray conversation=new JSONArray(snapshot); FolderTools folder=new FolderTools(this,prefs.getString("folder_uri","")); boolean done=false;
                for(int turn=0;turn<12;turn++) { JSONObject data=new JSONObject().put("model",model).put("messages",conversation).put("stream",false).put("tools",FolderTools.definitions()); JSONObject response=request(endpoint,"/chat/completions",secret,data,false); JSONObject reply=response.getJSONArray("choices").getJSONObject(0).getJSONObject("message"); JSONArray calls=reply.optJSONArray("tool_calls"); if(calls==null||calls.length()==0) { conversation.put(new JSONObject().put("role","assistant").put("content",reply.optString("content",""))); done=true; break; }
                    conversation.put(reply); for(int i=0;i<calls.length();i++) { JSONObject call=calls.getJSONObject(i), f=call.getJSONObject("function"); String result; try { result=folder.call(f.getString("name"),new JSONObject(f.optString("arguments","{}"))); } catch(Exception e) { result=new JSONObject().put("error",String.valueOf(e.getMessage())).toString(); } conversation.put(new JSONObject().put("role","tool").put("tool_call_id",call.getString("id")).put("content",result)); }
                    JSONArray progress=new JSONArray(conversation.toString()); runOnUiThread(() -> publishLocalProgress(sentSession,progress,false));
                } if(!done) conversation.put(new JSONObject().put("role","assistant").put("content","任务已暂停：工具调用次数达到上限，请发送消息继续。")); JSONArray completed=conversation; runOnUiThread(() -> publishLocalProgress(sentSession,completed,true)); }
        } catch(Exception ex) { runOnUiThread(() -> { busy=false; MainActivity view=activeActivity.get(); if(wasRemote) { String draft=prefs.getString("draft_remote",""); if(draft.isEmpty()) { prefs.edit().putString("draft_remote",prompt).apply(); if(view!=null && !view.destroyed && view.remote && view.input.length()==0) view.input.setText(prompt); } } if(view!=null && !view.destroyed) { if(view.remote==wasRemote) view.status.setText("发送失败："+ex.getMessage()); view.toast("发送失败，请检查连接与设置"); } }); } });
    }
    private static void publishLocalProgress(String sessionId, JSONArray result, boolean completed) {
        try {
            sharedSessionStore.save(sessionId,result);
            MainActivity view=activeActivity.get();
            if(view!=null && !view.destroyed && sessionId.equals(view.sessionStore.currentId())) {
                view.localMessages=result;
                if(!view.remote) { view.renderLocal(); view.status.setText(completed?"手机本地会话 · 消息保存在本机":"正在处理手机文件…"); }
            }
        } catch (RuntimeException e) {
            MainActivity view=activeActivity.get();
            if(view!=null && !view.destroyed) view.toast("保存会话失败，请检查手机存储空间");
        } finally { if(completed) busy=false; }
    }
    private void poll() {
        if(!remote||polling||destroyed) return; final String endpoint=prefs.getString("remote_url", "").trim(); final String token;
        try { validateUrl(endpoint,true); token=readSecret("remote_token"); if(token.isEmpty()) throw new Exception("请在设置中填写电脑配对令牌"); } catch(Exception ex) { status.setText(ex.getMessage()); return; }
        polling=true; remoteWorker.execute(() -> { try { JSONObject result=request(endpoint,"/v1/state",token,null,true); runOnUiThread(() -> { polling=false; if(remote&&!destroyed) { JSONArray rows=result.optJSONArray("messages") == null ? new JSONArray() : result.optJSONArray("messages"); String key=rows.toString(); if(!key.equals(lastRemoteMessages)) { lastRemoteMessages=key; render(rows); } remoteRunning=result.optBoolean("running"); String currentModel=result.optString("model",""); if(!currentModel.equals(remoteModel)) { remoteModel=currentModel; refreshTabs(); } renderRemoteProgress(result.optJSONArray("operations"),result.optString("streamText","")); renderRemoteControls(result.optJSONArray("pendingApprovals")); status.setText((remoteRunning?"电脑正在执行":"已连接电脑")+" · "+result.optString("title","会话")); handler.removeCallbacks(pollTask); handler.postDelayed(pollTask,2000); } }); }
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
        LinearLayout form=new LinearLayout(this); form.setOrientation(LinearLayout.VERTICAL); form.setPadding(dp(20),dp(4),dp(20),0);
        Button models=button("管理模型与账号"); form.addView(models); models.setOnClickListener(v->modelStore.showManager(()->refreshTabs()));
        Button folder=button("授权手机文件夹"); LinearLayout.LayoutParams fp0=new LinearLayout.LayoutParams(-1,dp(48)); fp0.topMargin=dp(8); form.addView(folder,fp0); folder.setOnClickListener(v->chooseFolder());
        TextView hint=text("电脑远程配对",14,MUTED); hint.setPadding(0,dp(18),0,0); form.addView(hint);
        EditText computer=field(form,"电脑地址（https://地址:端口）",prefs.getString("remote_url",""),false), fingerprint=field(form,"电脑证书 SHA-256 指纹",prefs.getString("remote_fingerprint",""),false), token=field(form,"电脑配对令牌（留空保持原值）","",true);
        ScrollView scrollForm=new ScrollView(this); scrollForm.addView(form); new AlertDialog.Builder(this).setTitle("设置").setView(scrollForm).setPositiveButton("保存", (d,w)-> { try { if(!computer.getText().toString().trim().isEmpty()) validateUrl(computer.getText().toString().trim(),true); String fp=fingerprint.getText().toString().replace(":","").replace(" ",""); if(!fp.isEmpty()&&!fp.matches("(?i)[0-9a-f]{64}")) throw new Exception("证书指纹必须为 64 位十六进制字符"); if(token.length()>0) writeSecret("remote_token",token.getText().toString()); prefs.edit().putString("remote_url",computer.getText().toString().trim()).putString("remote_fingerprint",fp).apply(); if(remote) poll(); toast("设置已保存"); } catch(Exception ex) { toast("设置未保存："+ex.getMessage()); } }).setNegativeButton("取消",null).show();
    }
    @Override protected void onActivityResult(int requestCode,int resultCode,Intent data) { super.onActivityResult(requestCode,resultCode,data); if(requestCode==41&&resultCode==RESULT_OK&&data!=null&&data.getData()!=null) { Uri uri=data.getData(); int flags=data.getFlags() & (Intent.FLAG_GRANT_READ_URI_PERMISSION|Intent.FLAG_GRANT_WRITE_URI_PERMISSION); if(flags!=(Intent.FLAG_GRANT_READ_URI_PERMISSION|Intent.FLAG_GRANT_WRITE_URI_PERMISSION)) { toast("请选择允许读取和写入的文件夹"); return; } try { getContentResolver().takePersistableUriPermission(uri,flags); prefs.edit().putString("folder_uri",uri.toString()).apply(); toast("文件夹已授权"); } catch(Exception e) { toast("文件夹授权失败"); } } }
    private SecretKey key() throws Exception { KeyStore ks=KeyStore.getInstance("AndroidKeyStore"); ks.load(null); if(!ks.containsAlias("cortex_secrets")) { KeyGenerator g=KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES,"AndroidKeyStore"); g.init(new KeyGenParameterSpec.Builder("cortex_secrets",KeyProperties.PURPOSE_ENCRYPT|KeyProperties.PURPOSE_DECRYPT).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build()); g.generateKey(); } return (SecretKey)ks.getKey("cortex_secrets",null); }
    private void writeSecret(String name,String value) throws Exception { Cipher c=Cipher.getInstance("AES/GCM/NoPadding"); c.init(Cipher.ENCRYPT_MODE,key()); byte[] encrypted=c.doFinal(value.getBytes(StandardCharsets.UTF_8)); prefs.edit().putString(name,Base64.encodeToString(c.getIV(),Base64.NO_WRAP)+":"+Base64.encodeToString(encrypted,Base64.NO_WRAP)).apply(); }
    private String readSecret(String name) throws Exception { String v=prefs.getString(name,""); if(v.isEmpty()) return ""; String[] p=v.split(":",2); Cipher c=Cipher.getInstance("AES/GCM/NoPadding"); c.init(Cipher.DECRYPT_MODE,key(),new GCMParameterSpec(128,Base64.decode(p[0],Base64.NO_WRAP))); return new String(c.doFinal(Base64.decode(p[1],Base64.NO_WRAP)),StandardCharsets.UTF_8); }
    private void toast(String s) { Toast.makeText(this,s,Toast.LENGTH_LONG).show(); }
    @Override protected void onDestroy() { destroyed=true; if(activeActivity.get()==this) activeActivity.clear(); handler.removeCallbacksAndMessages(null); worker.shutdown(); remoteWorker.shutdown(); super.onDestroy(); }
}
