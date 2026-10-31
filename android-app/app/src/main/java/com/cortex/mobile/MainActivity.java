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
    private static volatile String localStreamSession="",localStreamText="",localStreamThinking="";
    private static java.lang.ref.WeakReference<MainActivity> activeActivity = new java.lang.ref.WeakReference<>(null);
    private TextView modelButton, projectButton, chatTab, computerTab;
    private String remoteModel="", remoteWorkspace="";
    private SharedPreferences prefs;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final ExecutorService remoteWorker = Executors.newFixedThreadPool(3);
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable pollTask = this::poll;
    private LinearLayout messages, remoteControls, remoteProgress;
    AttachmentController attachmentController;
    LinearLayout attachmentPreview;
    private ScrollView scroll;
    private View mainPage, currentPage, pairingPage;
    private FrameLayout pageHost;
    private boolean pageChanging;
    private EditText pairingAddress,pairingFingerprint,pairingToken;
    private boolean secondaryPage, computerSettingsPage, reopenSettingsAfterRecreate;
    private EditText input;
    private TextView status, title;
    private boolean remote = false, destroyed = false, polling = false;
    private boolean remoteRunning = false, controlBusy = false;
    private String lastRemoteMessages = "", lastRemoteProgress = "";
    private final java.util.Map<String,Boolean> toolExpanded = new java.util.HashMap<>();
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
        attachmentController=new AttachmentController(this,this::renderAttachmentPreview);
        Object retained=getLastNonConfigurationInstance();if(retained instanceof JSONObject)try{attachmentController.restore((JSONObject)retained);}catch(Exception ignored){}
        remote=prefs.getBoolean("remote_mode",false); build(); input.setText(prefs.getString(remote?"draft_remote":"draft_local", "")); refreshMode();
        renderAttachmentPreview();
        if(state!=null && state.getBoolean("reopen_settings_after_theme")) settings(false);
    }
    @Override protected void onSaveInstanceState(Bundle state) { state.putBoolean("reopen_settings_after_theme",reopenSettingsAfterRecreate); super.onSaveInstanceState(state); }
    @Override public Object onRetainNonConfigurationInstance() { try{return attachmentController==null?null:attachmentController.snapshot();}catch(Exception ignored){return null;} }
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
        String selected=remote?remoteModel:modelStore.selectedModel();
        modelButton.setText(selected.isEmpty()?"选择模型":selected);
        String project=remote?remoteWorkspace:prefs.getString("folder_name","");
        if(!remote && project.isEmpty() && !prefs.getString("folder_uri","").isEmpty()) { project=folderName(Uri.parse(prefs.getString("folder_uri",""))); if(!project.isEmpty()) prefs.edit().putString("folder_name",project).apply(); }
        projectButton.setText(project.isEmpty()?"选择项目":shortProjectName(project));
        projectButton.setContentDescription(project.isEmpty()?"选择项目":"项目："+project);
        modelButton.setEnabled(true);
    }
    private static String shortProjectName(String value) { return ProjectName.abbreviate(value); }
    private String folderName(Uri uri) { try { Uri doc=android.provider.DocumentsContract.buildDocumentUriUsingTree(uri,android.provider.DocumentsContract.getTreeDocumentId(uri)); try(android.database.Cursor c=getContentResolver().query(doc,new String[]{android.provider.DocumentsContract.Document.COLUMN_DISPLAY_NAME},null,null,null)){if(c!=null&&c.moveToFirst()&&!c.isNull(0))return c.getString(0);}String id=android.provider.DocumentsContract.getTreeDocumentId(uri);int index=Math.max(id.lastIndexOf('/'),id.lastIndexOf(':'));return index>=0&&index+1<id.length()?id.substring(index+1):id; } catch(Exception ignored) {return "";} }
    private void updateRemoteWorkspace(String path) {String clean=path==null?"":path.replaceAll("[\\\\/]+$","");int index=Math.max(clean.lastIndexOf('\\'),clean.lastIndexOf('/'));remoteWorkspace=index>=0?clean.substring(index+1):clean;if(projectButton!=null&&remote)refreshTabs();}
    private void showRemoteWorkspaceSelector() {
        final String endpoint=prefs.getString("remote_url","").trim(), token;
        try { validateUrl(endpoint,true); token=readSecret("remote_token"); if(token.isEmpty())throw new Exception("请先配置电脑连接"); }
        catch(Exception e) { toast(e.getMessage()); return; }
        remoteWorker.execute(()->{ try {
            JSONArray workspaces=request(endpoint,"/v1/workspaces",token,null,true).optJSONArray("workspaces");
            if(workspaces==null || workspaces.length()==0) throw new Exception("电脑上没有已打开的项目，请先在电脑上打开项目");
            String[] labels=new String[workspaces.length()];
            for(int i=0;i<labels.length;i++){JSONObject item=workspaces.optJSONObject(i);labels[i]=item==null?"工作空间":item.optString("name","工作空间")+(item.optBoolean("active")?"  ✓":"");}
            runOnUiThread(()->{ if(destroyed || !remote)return; new AlertDialog.Builder(this).setTitle("选择电脑工作空间").setItems(labels,(dialog,index)->{
                JSONObject item=workspaces.optJSONObject(index); if(item==null)return; String id=item.optString("id","");
                remoteWorker.execute(()->{try{JSONObject chosen=request(endpoint,"/v1/workspace",token,new JSONObject().put("id",id),true);runOnUiThread(()->{if(!destroyed&&remote){updateRemoteWorkspace(chosen.optString("name",""));lastRemoteMessages="";lastRemoteProgress="";handler.removeCallbacks(pollTask);poll();}});}catch(Exception e){runOnUiThread(()->{if(!destroyed)toast("切换工作空间失败："+e.getMessage());});}});
            }).setNegativeButton("取消",null).show(); });
        } catch(Exception e) {runOnUiThread(()->{if(!destroyed)toast("获取电脑工作空间失败："+e.getMessage());});} });
    }
    private void build() {
        LinearLayout root = new LinearLayout(this); root.setOrientation(LinearLayout.VERTICAL); root.setBackgroundColor(BG); mainPage=root; applySafeInsets(root,14,12,14,10); setContentView(root);
        android.widget.FrameLayout top=new android.widget.FrameLayout(this); root.addView(top,new LinearLayout.LayoutParams(-1,dp(44)));
        ImageButton menu=new ImageButton(this); menu.setImageResource(R.drawable.history_menu); menu.setColorFilter(TEXT); menu.setScaleType(ImageView.ScaleType.CENTER); menu.setBackground(rounded(PANEL,22)); android.widget.FrameLayout.LayoutParams left=new android.widget.FrameLayout.LayoutParams(dp(38),dp(38),Gravity.START|Gravity.CENTER_VERTICAL); top.addView(menu,left); menu.setContentDescription("会话历史"); menu.setOnClickListener(v->showHistory());
        LinearLayout tabs=new LinearLayout(this); tabs.setPadding(dp(3),dp(3),dp(3),dp(3)); tabs.setBackground(rounded(PANEL,24)); android.widget.FrameLayout.LayoutParams middle=new android.widget.FrameLayout.LayoutParams(Math.min(dp(190),Math.max(dp(140),getResources().getDisplayMetrics().widthPixels-dp(130))),dp(38),Gravity.CENTER); top.addView(tabs,middle);
        chatTab=control("对话",13); computerTab=control("连接电脑",13); tabs.addView(chatTab,new LinearLayout.LayoutParams(0,-1,1)); tabs.addView(computerTab,new LinearLayout.LayoutParams(0,-1,1)); chatTab.setOnClickListener(v->changeMode(false)); computerTab.setOnClickListener(v->changeMode(true));
        TextView config=control("⚙",18); android.widget.FrameLayout.LayoutParams right=new android.widget.FrameLayout.LayoutParams(dp(38),dp(38),Gravity.END|Gravity.CENTER_VERTICAL); top.addView(config,right); config.setContentDescription("设置"); config.setOnClickListener(v->settings());
        title=text("Cortex",14,TEXT); title.setVisibility(View.GONE);
        status=new ThinkingTextView(this); status.setTextSize(12); status.setTextColor(MUTED); status.setGravity(Gravity.CENTER); status.setPadding(0,dp(6),0,dp(2)); status.setVisibility(View.GONE); status.addTextChangedListener(new TextWatcher(){ public void beforeTextChanged(CharSequence s,int start,int count,int after){} public void onTextChanged(CharSequence s,int start,int before,int count){ String value=s.toString(); status.setVisibility(value.isEmpty() || value.equals("手机本地会话") || value.equals("手机本地会话 · 消息保存在本机") ? View.GONE : View.VISIBLE); ((ThinkingTextView)status).setActive(value.contains("正在") || value.equals("任务仍在执行，请等待完成")); } public void afterTextChanged(Editable e){} }); root.addView(status);
        remoteControls=new LinearLayout(this); remoteControls.setOrientation(LinearLayout.VERTICAL); root.addView(remoteControls);
        scroll=new ScrollView(this); scroll.setFillViewport(true); scroll.setClipToPadding(false); root.addView(scroll,new LinearLayout.LayoutParams(-1,0,1));
        LinearLayout feed=new LinearLayout(this); feed.setOrientation(LinearLayout.VERTICAL); scroll.addView(feed); messages=new LinearLayout(this); messages.setOrientation(LinearLayout.VERTICAL); feed.addView(messages); remoteProgress=new LinearLayout(this); remoteProgress.setOrientation(LinearLayout.VERTICAL); feed.addView(remoteProgress);
        LinearLayout composer=new LinearLayout(this); composer.setOrientation(LinearLayout.VERTICAL); composer.setPadding(dp(14),dp(6),dp(8),dp(8)); composer.setBackground(rounded(PANEL,24)); root.addView(composer);
        attachmentPreview=new LinearLayout(this); attachmentPreview.setOrientation(LinearLayout.VERTICAL); composer.addView(attachmentPreview);
        input=new EditText(this); input.setTextColor(TEXT); input.setHintTextColor(MUTED); input.setHint("输入消息，开始对话…"); input.setTextSize(16); input.setMinLines(1); input.setMaxLines(5); input.setPadding(dp(2),dp(8),dp(2),dp(8)); input.setBackgroundColor(Color.TRANSPARENT); composer.addView(input,new LinearLayout.LayoutParams(-1,-2));
        input.addTextChangedListener(new TextWatcher() { public void beforeTextChanged(CharSequence s,int start,int count,int after) {} public void onTextChanged(CharSequence s,int start,int before,int count) { prefs.edit().putString(remote?"draft_remote":"draft_local",s.toString()).apply(); } public void afterTextChanged(Editable e) {} });
        LinearLayout actions=new LinearLayout(this); actions.setGravity(Gravity.CENTER_VERTICAL); composer.addView(actions,new LinearLayout.LayoutParams(-1,dp(38)));
        projectButton=control("选择项目",13);projectButton.setPadding(dp(8),0,dp(8),0);projectButton.setSingleLine(true);projectButton.setCompoundDrawablesRelativeWithIntrinsicBounds(R.drawable.composer_folder,0,0,0);projectButton.setCompoundDrawablePadding(dp(4));projectButton.setCompoundDrawableTintList(android.content.res.ColorStateList.valueOf(TEXT));projectButton.setBackground(rounded(light?0xffdfe2e8:0xff36383c,18));actions.addView(projectButton,new LinearLayout.LayoutParams(-2,dp(34)));projectButton.setOnClickListener(v->{if(busy){toast("请等待当前任务结束");return;}if(remote)showRemoteWorkspaceSelector();else chooseFolder();});
        android.widget.FrameLayout modelSlot=new android.widget.FrameLayout(this);LinearLayout.LayoutParams modelParams=new LinearLayout.LayoutParams(0,dp(34),1);modelParams.leftMargin=dp(6);actions.addView(modelSlot,modelParams);
        modelButton=control("选择模型",13);modelButton.setPadding(dp(8),0,dp(8),0);modelButton.setSingleLine(true);modelButton.setEllipsize(android.text.TextUtils.TruncateAt.END);modelButton.setCompoundDrawablesRelativeWithIntrinsicBounds(R.drawable.composer_model,0,0,0);modelButton.setCompoundDrawablePadding(dp(4));modelButton.setCompoundDrawableTintList(android.content.res.ColorStateList.valueOf(TEXT));modelButton.setBackground(rounded(light?0xffdfe2e8:0xff36383c,18));modelSlot.addView(modelButton,new android.widget.FrameLayout.LayoutParams(-2,dp(34),Gravity.START));modelButton.setOnClickListener(v->showModelSelector());
        TextView folder=control("+",22);folder.setTypeface(Typeface.DEFAULT,Typeface.BOLD);GradientDrawable folderOutline=rounded(Color.TRANSPARENT,16);folderOutline.setStroke(dp(1),TEXT);folder.setBackground(folderOutline);folder.setContentDescription("添加附件");LinearLayout.LayoutParams folderParams=new LinearLayout.LayoutParams(dp(32),dp(32));folderParams.leftMargin=dp(6);actions.addView(folder,folderParams);folder.setOnClickListener(v->{if(busy){toast("请等待当前任务结束");return;}if(attachmentController!=null)attachmentController.show();});
        ImageButton send=new ImageButton(this);send.setImageResource(R.drawable.send_plane);send.setScaleType(ImageView.ScaleType.CENTER);send.setColorFilter(TEXT);GradientDrawable sendOutline=rounded(Color.TRANSPARENT,16);sendOutline.setStroke(dp(1),TEXT);send.setBackground(sendOutline);LinearLayout.LayoutParams sp=new LinearLayout.LayoutParams(dp(32),dp(32));sp.leftMargin=dp(8);actions.addView(send,sp);send.setContentDescription("发送消息");send.setOnClickListener(v->send());
    }
    private void chooseFolder() { Intent intent=new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE); intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION|Intent.FLAG_GRANT_WRITE_URI_PERMISSION|Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION); startActivityForResult(intent,41); }
    private boolean blockedSwipe(View view,float x,float y,boolean drawer) {
        if(view==null || view.getVisibility()!=View.VISIBLE)return false;
        int[] location=new int[2];view.getLocationOnScreen(location);if(x<location[0]||y<location[1]||x>=location[0]+view.getWidth()||y>=location[1]+view.getHeight())return false;
        if(view instanceof EditText || view instanceof HorizontalScrollView || view instanceof SeekBar || view.canScrollHorizontally(-1) || view.canScrollHorizontally(1))return true;
        if(view instanceof android.view.ViewGroup){android.view.ViewGroup group=(android.view.ViewGroup)view;for(int i=group.getChildCount()-1;i>=0;i--)if(blockedSwipe(group.getChildAt(i),x,y,drawer))return true;}
        return !drawer && (view instanceof Button || view instanceof ImageButton || (view instanceof TextView && view.isClickable() && !((TextView)view).isTextSelectable()));
    }
    private final class GestureSession {
        float x,y;long started;boolean tracking;
        int read(android.view.MotionEvent event,View root,boolean drawer){int action=event.getActionMasked();
            if(action==android.view.MotionEvent.ACTION_DOWN){x=event.getRawX();y=event.getRawY();started=event.getEventTime();float edge=dp(24);tracking=event.getPointerCount()==1 && x>=edge && x<getResources().getDisplayMetrics().widthPixels-edge && !blockedSwipe(root,x,y,drawer);}
            else if(action==android.view.MotionEvent.ACTION_POINTER_DOWN || action==android.view.MotionEvent.ACTION_CANCEL)tracking=false;
            else if(action==android.view.MotionEvent.ACTION_UP){boolean valid=tracking;tracking=false;return valid?SwipeDirection.recognize(event.getRawX()-x,event.getRawY()-y,event.getEventTime()-started,dp(80)):0;}return 0;
        }
    }
    private final GestureSession mainGestures=new GestureSession();
    @Override public boolean dispatchTouchEvent(android.view.MotionEvent event) {
        if(pageChanging) return true;
        int direction=mainGestures.read(event,secondaryPage?currentPage:mainPage,false);
        if((!secondaryPage && (SwipeDirection.openHistory(direction) || SwipeDirection.openSettings(direction))) || (secondaryPage && SwipeDirection.closeSettings(direction,computerSettingsPage))) {
            android.view.MotionEvent cancel=android.view.MotionEvent.obtain(event);cancel.setAction(android.view.MotionEvent.ACTION_CANCEL);super.dispatchTouchEvent(cancel);cancel.recycle();
            if(secondaryPage)leavePage();else if(SwipeDirection.openHistory(direction))showHistory();else settings();return true;
        }
        return super.dispatchTouchEvent(event);
    }
    private void showHistory() {
        final GestureSession gestures=new GestureSession();
        Dialog drawer=new Dialog(this) { @Override public boolean dispatchTouchEvent(android.view.MotionEvent event) {int direction=gestures.read(event,getWindow().getDecorView(),true);if(SwipeDirection.closeHistory(direction)){android.view.MotionEvent cancel=android.view.MotionEvent.obtain(event);cancel.setAction(android.view.MotionEvent.ACTION_CANCEL);super.dispatchTouchEvent(cancel);cancel.recycle();dismiss();return true;}return super.dispatchTouchEvent(event);} };
        LinearLayout panel=new LinearLayout(this); panel.setOrientation(LinearLayout.VERTICAL); applySafeInsets(panel,18,20,18,18); panel.setBackgroundColor(light?0xfff0f1f3:0xff101113);
        HistoryController history=new HistoryController(drawer,panel);
        final int width=Math.min(dp(320),getResources().getDisplayMetrics().widthPixels-dp(48)); final android.view.ViewGroup content=(android.view.ViewGroup)mainPage;
        final View shade=new View(this); shade.setBackgroundColor(light?0x66000000:0x4dffffff); shade.setAlpha(0); shade.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        final View.OnLayoutChangeListener resizeShade=(v,l,t,r,b,ol,ot,oright,ob)->shade.layout(0,0,r-l,b-t);
        drawer.setOnShowListener(d->{content.animate().cancel(); content.setBackground(rounded(BG,24)); content.setClipToOutline(true); shade.layout(0,0,content.getWidth(),content.getHeight()); content.getOverlay().add(shade); content.addOnLayoutChangeListener(resizeShade); getWindow().setStatusBarColor(light?0xff949495:0xff58595a);getWindow().setNavigationBarColor(light?0xff949495:0xff58595a);shade.animate().alpha(1).setDuration(240).start(); content.animate().translationX(width).setDuration(240).setInterpolator(new android.view.animation.DecelerateInterpolator()).start();});
        drawer.setOnDismissListener(d->{content.removeOnLayoutChangeListener(resizeShade);getWindow().setStatusBarColor(BG);getWindow().setNavigationBarColor(BG);shade.animate().cancel();shade.animate().alpha(0).setDuration(200).withEndAction(()->content.getOverlay().remove(shade)).start(); content.animate().cancel(); content.animate().translationX(0).setDuration(200).setInterpolator(new android.view.animation.DecelerateInterpolator()).withEndAction(()->{content.setClipToOutline(false);content.setBackgroundColor(BG);}).start();});
        drawer.setContentView(panel); Window window=drawer.getWindow(); if(window!=null){ window.setBackgroundDrawableResource(android.R.color.transparent); window.clearFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND); window.setWindowAnimations(R.style.CortexDrawerAnimation); window.setLayout(width,WindowManager.LayoutParams.MATCH_PARENT); window.setGravity(Gravity.START); window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE); } drawer.show(); if(window!=null) window.setLayout(width,WindowManager.LayoutParams.MATCH_PARENT);
    }
    private final class HistoryController {
        final Dialog drawer; final LinearLayout list,normalFooter,selectionFooter,toolbar; final EditText search; final TextView pin,delete,selectMode,brand; final FrameLayout searchWrap; final ImageButton searchButton,closeSelection;
        final java.util.Set<String> selected=new java.util.LinkedHashSet<>(); boolean selecting=false, allPinned=false,searchOpen=false;
        boolean footerInitialized=false,footerTarget=false;int footerGeneration=0;
        HistoryController(Dialog drawer, LinearLayout panel) {
            this.drawer=drawer;
            LinearLayout head=new LinearLayout(MainActivity.this);head.setGravity(Gravity.CENTER_VERTICAL);panel.addView(head);
            brand=text("Cortex",23,TEXT);brand.setTypeface(null,Typeface.BOLD);head.addView(brand,new LinearLayout.LayoutParams(0,dp(44),1));
            searchWrap=new FrameLayout(MainActivity.this);searchWrap.setVisibility(View.GONE);searchWrap.setBackground(rounded(PANEL,22));head.addView(searchWrap,new LinearLayout.LayoutParams(dp(195),dp(42)));
            search=new EditText(MainActivity.this);search.setSingleLine(true);search.setTextColor(TEXT);search.setHintTextColor(MUTED);search.setHint("搜索对话内容…");search.setTextSize(14);search.setPadding(dp(12),0,dp(36),0);search.setBackgroundColor(Color.TRANSPARENT);searchWrap.addView(search,new FrameLayout.LayoutParams(-1,-1));
            ImageButton clearSearch=new ImageButton(MainActivity.this);clearSearch.setImageResource(R.drawable.history_close);clearSearch.setColorFilter(MUTED);clearSearch.setScaleType(ImageView.ScaleType.CENTER);clearSearch.setBackgroundColor(Color.TRANSPARENT);clearSearch.setContentDescription("关闭搜索");searchWrap.addView(clearSearch,new FrameLayout.LayoutParams(dp(36),-1,Gravity.END));clearSearch.setOnClickListener(v->closeSearch());
            searchButton=new ImageButton(MainActivity.this);searchButton.setImageResource(R.drawable.history_search);searchButton.setColorFilter(TEXT);searchButton.setScaleType(ImageView.ScaleType.CENTER);searchButton.setBackground(rounded(PANEL,22));searchButton.setContentDescription("搜索会话");head.addView(searchButton,new LinearLayout.LayoutParams(dp(40),dp(40)));
            closeSelection=new ImageButton(MainActivity.this);closeSelection.setImageResource(R.drawable.history_close);closeSelection.setColorFilter(TEXT);closeSelection.setScaleType(ImageView.ScaleType.CENTER);closeSelection.setBackground(rounded(PANEL,22));closeSelection.setContentDescription("关闭多选");closeSelection.setVisibility(View.GONE);head.addView(closeSelection,new LinearLayout.LayoutParams(dp(40),dp(40)));closeSelection.setOnClickListener(v->{selecting=false;selected.clear();update();});
            searchButton.setOnClickListener(v->{searchOpen=true;searchButton.setVisibility(View.GONE);searchWrap.setVisibility(View.VISIBLE);searchWrap.setPivotX(dp(195));searchWrap.setScaleX(0);searchWrap.animate().scaleX(1).setDuration(220).start();search.requestFocus();search.post(()->{if(searchOpen&&!selecting)((InputMethodManager)getSystemService(Context.INPUT_METHOD_SERVICE)).showSoftInput(search,InputMethodManager.SHOW_IMPLICIT);});});
            toolbar=new LinearLayout(MainActivity.this);toolbar.setGravity(Gravity.CENTER_VERTICAL);LinearLayout.LayoutParams tb=new LinearLayout.LayoutParams(-1,dp(46));tb.topMargin=dp(12);panel.addView(toolbar,tb);
            TextView newChat=text("＋  新建对话",15,TEXT);newChat.setGravity(Gravity.CENTER_VERTICAL);toolbar.addView(newChat,new LinearLayout.LayoutParams(0,-1,1));newChat.setOnClickListener(v->{if(busy){toast("请等待当前任务结束");return;}String id=sessionStore.create();sessionStore.select(id);localMessages=sessionStore.load(id);changeMode(false);renderLocal();drawer.dismiss();});
            selectMode=control("☷",20);selectMode.setContentDescription("选择会话");toolbar.addView(selectMode,new LinearLayout.LayoutParams(dp(40),dp(40)));selectMode.setOnClickListener(v->{if(busy){toast("请等待当前任务结束");return;}selecting=!selecting;selected.clear();update();});
            ScrollView scroll=new ScrollView(MainActivity.this);panel.addView(scroll,new LinearLayout.LayoutParams(-1,0,1));list=new LinearLayout(MainActivity.this);list.setOrientation(LinearLayout.VERTICAL);scroll.addView(list);
            search.addTextChangedListener(new TextWatcher(){public void beforeTextChanged(CharSequence s,int a,int c,int d){} public void onTextChanged(CharSequence s,int a,int b,int c){update();}public void afterTextChanged(Editable e){}});
            FrameLayout footerHost=new FrameLayout(MainActivity.this);panel.addView(footerHost,new LinearLayout.LayoutParams(-1,dp(52)));
            normalFooter=new LinearLayout(MainActivity.this);normalFooter.setGravity(Gravity.CENTER_VERTICAL);footerHost.addView(normalFooter,new FrameLayout.LayoutParams(-1,-1));
            String selectedModel=remote?remoteModel:modelStore.selectedModel();TextView models=text(selectedModel==null||selectedModel.isEmpty()?"选择模型":selectedModel,14,TEXT);models.setSingleLine(true);models.setEllipsize(android.text.TextUtils.TruncateAt.END);models.setGravity(Gravity.CENTER_VERTICAL|Gravity.START);models.setPadding(dp(12),0,dp(8),0);normalFooter.addView(models,new LinearLayout.LayoutParams(0,dp(44),1));models.setOnClickListener(v->{if(selecting)return;drawer.dismiss();handler.postDelayed(()->{if(!destroyed)showModelSelector();},220);});
            selectionFooter=new LinearLayout(MainActivity.this);selectionFooter.setGravity(Gravity.CENTER_VERTICAL);footerHost.addView(selectionFooter,new FrameLayout.LayoutParams(-1,-1));
            FrameLayout pinArea=new FrameLayout(MainActivity.this);selectionFooter.addView(pinArea,new LinearLayout.LayoutParams(0,-1,1));pin=text("置顶",15,MUTED);pin.setGravity(Gravity.CENTER);pin.setPadding(dp(8),0,dp(8),0);pin.setCompoundDrawablesRelativeWithIntrinsicBounds(R.drawable.history_pin,0,0,0);pin.setCompoundDrawablePadding(dp(6));pinArea.addView(pin,new FrameLayout.LayoutParams(-2,-1,Gravity.CENTER));pinArea.setOnClickListener(v->{if(pin.isEnabled())pin.performClick();});View line=new View(MainActivity.this);line.setBackgroundColor(MUTED);selectionFooter.addView(line,new LinearLayout.LayoutParams(dp(1),dp(28)));
            FrameLayout deleteArea=new FrameLayout(MainActivity.this);selectionFooter.addView(deleteArea,new LinearLayout.LayoutParams(0,-1,1));delete=text("删除",15,MUTED);delete.setGravity(Gravity.CENTER);delete.setPadding(dp(8),0,dp(8),0);delete.setCompoundDrawablesRelativeWithIntrinsicBounds(R.drawable.history_delete,0,0,0);delete.setCompoundDrawablePadding(dp(6));deleteArea.addView(delete,new FrameLayout.LayoutParams(-2,-1,Gravity.CENTER));deleteArea.setOnClickListener(v->{if(delete.isEnabled())delete.performClick();});
            pin.setOnClickListener(v->{if(selected.isEmpty())return;if(busy){toast("请等待当前任务结束");return;}sessionStore.setPinned(selected,!allPinned);selected.clear();selecting=false;update();});
            delete.setOnClickListener(v->{if(selected.isEmpty())return;if(busy){toast("请等待当前任务结束");return;}new AlertDialog.Builder(MainActivity.this).setTitle("删除会话？").setMessage("确定删除选中的 "+selected.size()+" 个会话吗？").setNegativeButton("取消",null).setPositiveButton("删除",(d,w)->{if(busy){toast("请等待当前任务结束");return;}sessionStore.deleteMany(selected);selected.clear();selecting=false;localMessages=sessionStore.load(sessionStore.currentId());if(!remote)renderLocal();update();}).show();});
            update();
        }
        void closeSearch(){searchOpen=false;searchWrap.animate().cancel();searchWrap.setVisibility(View.GONE);searchWrap.setScaleX(1);search.clearFocus();((InputMethodManager)getSystemService(Context.INPUT_METHOD_SERVICE)).hideSoftInputFromWindow(search.getWindowToken(),0);searchButton.setVisibility(selecting?View.GONE:View.VISIBLE);if(search.length()>0)search.setText("");}
        void syncHeader(){if(selecting&&searchOpen)closeSearch();brand.setText(selecting?"选择对话":"Cortex");toolbar.setVisibility(selecting?View.GONE:View.VISIBLE);closeSelection.setVisibility(selecting?View.VISIBLE:View.GONE);searchButton.setVisibility(selecting||searchOpen?View.GONE:View.VISIBLE);}
        void showFooter(boolean select) {
            if(footerInitialized&&footerTarget==select)return;
            footerTarget=select;int generation=++footerGeneration;normalFooter.animate().cancel();selectionFooter.animate().cancel();
            View incoming=select?selectionFooter:normalFooter,outgoing=select?normalFooter:selectionFooter;
            if(!footerInitialized){footerInitialized=true;outgoing.setVisibility(View.GONE);incoming.setVisibility(View.VISIBLE);incoming.setAlpha(1);return;}
            if(incoming.getVisibility()==View.VISIBLE){outgoing.setVisibility(View.GONE);incoming.animate().alpha(1).setDuration(120).start();return;}
            incoming.setVisibility(View.GONE);
            if(outgoing.getVisibility()!=View.VISIBLE){incoming.setAlpha(0);incoming.setVisibility(View.VISIBLE);incoming.animate().alpha(1).setDuration(140).start();return;}
            outgoing.animate().alpha(0).setDuration(120).withEndAction(()->{if(generation!=footerGeneration||!drawer.isShowing())return;outgoing.setVisibility(View.GONE);incoming.setAlpha(0);incoming.setVisibility(View.VISIBLE);incoming.animate().alpha(1).setDuration(140).start();}).start();
        }
        void update(){
            syncHeader();showFooter(selecting);
            allPinned=!selected.isEmpty();JSONArray all=sessionStore.list("");for(int i=0;i<all.length();i++){JSONObject row=all.optJSONObject(i);if(row!=null&&selected.contains(row.optString("id"))&&!row.optBoolean("pinned"))allPinned=false;}pin.setText(allPinned?"取消置顶":"置顶");
            int pinColor=selected.isEmpty()?MUTED:TEXT,deleteColor=selected.isEmpty()?MUTED:(light?0xffbd3028:0xffff6b67);pin.setEnabled(!selected.isEmpty());delete.setEnabled(!selected.isEmpty());pin.setTextColor(pinColor);delete.setTextColor(deleteColor);pin.setCompoundDrawableTintList(android.content.res.ColorStateList.valueOf(pinColor));delete.setCompoundDrawableTintList(android.content.res.ColorStateList.valueOf(deleteColor));
            list.removeAllViews();JSONArray rows=sessionStore.list(search.getText().toString());if(rows.length()==0){TextView empty=text("暂无会话",14,MUTED);empty.setPadding(dp(8),dp(20),0,0);list.addView(empty);return;}
            String previous="";java.util.Calendar today=java.util.Calendar.getInstance();today.set(java.util.Calendar.HOUR_OF_DAY,0);today.set(java.util.Calendar.MINUTE,0);today.set(java.util.Calendar.SECOND,0);today.set(java.util.Calendar.MILLISECOND,0);
            for(int i=0;i<rows.length();i++){JSONObject row=rows.optJSONObject(i);if(row==null)continue;String id=row.optString("id"),name=row.optString("title","新会话");long when=row.optLong("updatedAt");long day=(today.getTimeInMillis()-when)/86400000L;String section=row.optBoolean("pinned")?"置顶":when>=today.getTimeInMillis()?"今天":day<1?"昨天":day<7?"7 天内":day<30?"30 天内":"更早";
                if(!section.equals(previous)){TextView heading=text(section,13,MUTED);heading.setPadding(dp(4),dp(18),0,dp(6));list.addView(heading);previous=section;}
                LinearLayout item=new LinearLayout(MainActivity.this);item.setGravity(Gravity.CENTER_VERTICAL);item.setPadding(dp(10),0,dp(10),0);if(!selecting&&id.equals(sessionStore.currentId()))item.setBackground(rounded(PANEL,12));list.addView(item,new LinearLayout.LayoutParams(-1,dp(52)));
                if(selecting){TextView mark=text(selected.contains(id)?"●":"○",19,selected.contains(id)?TEXT:MUTED);mark.setGravity(Gravity.CENTER);item.addView(mark,new LinearLayout.LayoutParams(dp(32),-1));}
                TextView title=text(name,16,TEXT);title.setSingleLine(true);title.setEllipsize(android.text.TextUtils.TruncateAt.END);title.setGravity(Gravity.CENTER_VERTICAL);item.addView(title,new LinearLayout.LayoutParams(0,-1,1));
                item.setOnClickListener(v->{if(busy){toast("请等待当前任务结束");return;}if(selecting){if(!selected.add(id))selected.remove(id);update();return;}sessionStore.select(id);localMessages=sessionStore.load(id);changeMode(false);renderLocal();drawer.dismiss();});
                item.setOnLongClickListener(v->{if(busy){toast("请等待当前任务结束");return true;}selecting=true;selected.add(id);update();return true;});
            }
        }
    }
    private void refreshMode() { refreshTabs(); handler.removeCallbacks(pollTask); title.setText(remote ? "电脑会话" : "Cortex"); remoteProgress.removeAllViews(); lastRemoteProgress=""; if(remote) { lastRemoteMessages=""; messages.removeAllViews(); poll(); } else { remoteControls.removeAllViews(); status.setText("手机本地会话 · 消息保存在本机"); renderLocal(); if(busy && sessionStore.currentId().equals(localStreamSession)) { renderRemoteProgress(new JSONArray(),localStreamText); status.setText(localStreamText.isEmpty()?"正在思考…":"正在回复…"); } } }
    private void renderLocal() { render(localMessages); }
    private void render(JSONArray rows) {
        boolean atBottom = isAtBottom(); int oldScroll=scroll.getScrollY(); messages.removeAllViews();
        if (rows.length() == 0) {
            messages.setLayoutParams(new LinearLayout.LayoutParams(-1,0,1));
            LinearLayout welcome=new LinearLayout(this);welcome.setOrientation(LinearLayout.VERTICAL);welcome.setGravity(Gravity.CENTER);welcome.setPadding(dp(20),dp(20),dp(20),dp(20));messages.addView(welcome,new LinearLayout.LayoutParams(-1,-1));
            ImageView logo=new ImageView(this);logo.setImageResource(R.drawable.cortex_logo);logo.setScaleType(ImageView.ScaleType.FIT_CENTER);logo.setPadding(dp(15),dp(15),dp(15),dp(15));logo.setContentDescription("Cortex 标志");GradientDrawable tile=rounded(light?0xffe9ebef:0xff1d1f23,20);tile.setStroke(dp(1),light?0xffd4d8df:0xff343940);logo.setBackground(tile);welcome.addView(logo,new LinearLayout.LayoutParams(dp(68),dp(68)));
            TextView eyebrow=text("CORTEX WORKSPACE",11,light?0xff677c92:0xffa8bed0);eyebrow.setGravity(Gravity.CENTER);eyebrow.setLetterSpacing(.15f);eyebrow.setTypeface(null,Typeface.BOLD);LinearLayout.LayoutParams ep=new LinearLayout.LayoutParams(-1,-2);ep.topMargin=dp(24);welcome.addView(eyebrow,ep);
            TextView heading=text("探索未至之境",25,TEXT);heading.setGravity(Gravity.CENTER);heading.setTypeface(null,Typeface.BOLD);LinearLayout.LayoutParams hp=new LinearLayout.LayoutParams(-1,-2);hp.topMargin=dp(18);welcome.addView(heading,hp);return;
        }
        messages.setLayoutParams(new LinearLayout.LayoutParams(-1,-2));
        ToolEventView tools=new ToolEventView(this,messages,light,toolExpanded);
        for (int i=0;i<rows.length();i++) { JSONObject m=rows.optJSONObject(i); if(m==null) continue; String role=m.optString("role"),type=m.optString("type");
            if(type.equals("notice")){tools.breakGroup();TextView notice=text(m.optString("content"),13,MUTED);notice.setPadding(dp(4),dp(8),dp(4),dp(8));notice.setTextIsSelectable(true);messages.addView(notice);continue;}
            if(type.equals("subagent")){tools.subagent(m);continue;}
            if(type.equals("tool_call")||type.equals("tool-start")||role.equals("tool-start")){tools.start(m.optString("id",m.optString("toolCallId")),m.optString("name"),m.has("content")?m.opt("content"):m.opt("args"));continue;}
            if(type.equals("tool_result")||type.equals("tool-result")||role.equals("tool-result")||role.equals("tool")){tools.finish(m.optString("id",m.optString("tool_call_id",m.optString("toolCallId"))),m.optString("name"),m.has("result")?m.opt("result"):m.opt("content"),m.optBoolean("error",false));continue;}
            if(!role.equals("user")&&!role.equals("assistant")) continue;
            JSONArray calls=m.optJSONArray("tool_calls"); if(calls==null)calls=m.optJSONArray("toolCalls");
            if(role.equals("assistant") && (m.isNull("content") || m.optString("content").isEmpty())) { renderToolCalls(tools,calls); continue; }
            tools.breakGroup();
            boolean fromUser=role.equals("user"); LinearLayout box=new LinearLayout(this); box.setOrientation(LinearLayout.VERTICAL); box.setPadding(fromUser?dp(14):dp(2),dp(10),fromUser?dp(14):dp(2),dp(10)); if(fromUser) box.setBackground(rounded(light?0xffdde6f6:0xff30343b,18));
            TextView body=text(m.optString("content"),16,TEXT); MarkdownRenderer.apply(body,m.optString("content"),light); if(fromUser) body.setMaxWidth(Math.min(dp(292),getResources().getDisplayMetrics().widthPixels-dp(118))); box.addView(body);
            JSONArray pictures=m.optJSONArray("attachments");if(pictures!=null)for(int j=0;j<pictures.length();j++){JSONObject picture=pictures.optJSONObject(j);if(picture==null)continue;String dataUrl=picture.optString("dataUrl","");if(!dataUrl.startsWith("data:image/jpeg;base64,")||dataUrl.length()>1500000)continue;try{byte[] bytes=Base64.decode(dataUrl.substring(dataUrl.indexOf(',')+1),Base64.NO_WRAP);android.graphics.BitmapFactory.Options options=new android.graphics.BitmapFactory.Options();options.inJustDecodeBounds=true;android.graphics.BitmapFactory.decodeByteArray(bytes,0,bytes.length,options);options.inSampleSize=1;while(Math.max(options.outWidth,options.outHeight)/options.inSampleSize>600)options.inSampleSize*=2;options.inJustDecodeBounds=false;android.graphics.Bitmap bitmap=android.graphics.BitmapFactory.decodeByteArray(bytes,0,bytes.length,options);if(bitmap!=null){ImageView thumb=new ImageView(this);thumb.setImageBitmap(bitmap);thumb.setContentDescription("已发送图片");thumb.setScaleType(ImageView.ScaleType.FIT_CENTER);LinearLayout.LayoutParams ip=new LinearLayout.LayoutParams(dp(180),dp(130));ip.topMargin=dp(6);box.addView(thumb,ip);}}catch(IllegalArgumentException ignored){}}
            LinearLayout.LayoutParams p=new LinearLayout.LayoutParams(fromUser?LinearLayout.LayoutParams.WRAP_CONTENT:LinearLayout.LayoutParams.MATCH_PARENT,-2); if(fromUser) p.gravity=Gravity.END; p.bottomMargin=dp(10); messages.addView(box,p); if(!fromUser)renderToolCalls(tools,calls);
        } restoreScroll(atBottom,oldScroll);
    }
    private void renderToolCalls(ToolEventView tools,JSONArray calls){if(calls==null)return;for(int i=0;i<calls.length();i++){JSONObject call=calls.optJSONObject(i);if(call==null)continue;JSONObject fn=call.optJSONObject("function");if(fn==null)fn=call;tools.start(call.optString("id"),fn.optString("name"),fn.opt("arguments"));}}
    private boolean isAtBottom() { return scroll.getChildCount()==0 || scroll.getScrollY()+scroll.getHeight()>=scroll.getChildAt(0).getHeight()-dp(60); }
    private void restoreScroll(boolean atBottom,int oldScroll) { scroll.post(() -> { if(atBottom) scroll.fullScroll(View.FOCUS_DOWN); else scroll.scrollTo(0,oldScroll); }); }
    private void saveMessages() { sessionStore.save(sessionStore.currentId(),localMessages); }
    private void showModelSelector() {
        if(!remote) { ModelSheet.show(this,modelStore,false,new JSONObject(),(id,effort)->refreshTabs()); return; }
        final String endpoint=prefs.getString("remote_url","").trim(), token;
        try { validateUrl(endpoint,true); token=readSecret("remote_token"); if(token.isEmpty()) throw new Exception("请先配置电脑连接"); } catch(Exception e) { toast(e.getMessage()); return; }
        remoteWorker.execute(()->{ try {
            JSONObject result=request(endpoint,"/v1/models",token,null,true); JSONArray models=result.optJSONArray("models");
            if(models==null || models.length()==0) throw new Exception("电脑未返回可用模型，请检查电脑的账号或模型配置");
            runOnUiThread(()->{ if(destroyed || !remote) return; ModelSheet.show(this,modelStore,true,result,(id,effort)->remoteWorker.execute(()->{ try {
                JSONObject response=request(endpoint,"/v1/model",token,new JSONObject().put("model",id),true);
                request(endpoint,"/v1/reasoning",token,new JSONObject().put("model",id).put("effort",effort),true);
                runOnUiThread(()->{ if(remote&&!destroyed) { remoteModel=response.optString("model",id); refreshTabs(); toast("电脑模型设置已更新"); } });
            } catch(Exception e) { runOnUiThread(()->{ if(!destroyed) { if(remote) poll(); toast("更新电脑模型设置失败："+e.getMessage()); } }); } })); });
        } catch(Exception e) { runOnUiThread(()->{ if(!destroyed) toast("获取电脑模型失败："+e.getMessage()); }); } });
    }
    private void send() {
        final JSONObject attached; try { attached=attachmentController.snapshot(); } catch(Exception e){toast("附件读取失败");return;}
        final String draft=input.getText().toString().trim(); if(draft.isEmpty()&&attached==null) return; if(busy) { toast("任务仍在执行，请等待完成"); return; }
        String combined=draft.isEmpty()?"请查看所附文件。":draft;
        if(attached!=null && "text".equals(attached.optString("kind"))) combined+="\n\n<附件 文件名=\""+attached.optString("name").replace("\"","_")+"\">\n"+attached.optString("content")+"\n</附件>";
        if(combined.length()>40000) {toast("消息和附件内容过长");return;} final String prompt=combined;
        final boolean wasRemote=remote; final ModelStore chosenModels=new ModelStore(this,prefs); final String endpoint=(wasRemote?prefs.getString("remote_url", ""):chosenModels.selectedUrl()).trim(); final String secret; final String model=chosenModels.selectedModel().trim(); final String provider=chosenModels.selectedProvider(), authMode=chosenModels.selectedAuthMode();
        try { secret=wasRemote?readSecret("remote_token"):chosenModels.selectedKey(); validateUrl(endpoint,wasRemote); if(secret.isEmpty()) throw new Exception("请先配置模型密钥或电脑配对令牌。"); if(!wasRemote && model.isEmpty()) throw new Exception("请先选择模型。"); }
        catch(Exception ex) { toast(ex.getMessage()); return; }
        final String effort=ModelSheet.effort(this,chosenModels.selectedProfile());
        input.setText(""); busy=true; status.setText(wasRemote?"正在发送到电脑…":"正在思考…");
        if(!wasRemote) { try { JSONObject m=new JSONObject().put("role","user").put("content",prompt);if(attached!=null&&"image".equals(attached.optString("kind")))m.put("attachments",new JSONArray().put(attached));localMessages.put(m); } catch(Exception ignored) {} saveMessages(); renderLocal(); }
        final String snapshot=localMessages.toString(); final String sentSession=sessionStore.currentId();
        final JSONArray[] working={null}; final StringBuilder partial=new StringBuilder(); final long[] lastDraw={0};
        if(!wasRemote){localStreamSession=sentSession;localStreamText="";localStreamThinking="";}
        (wasRemote ? remoteWorker : worker).execute(() -> { try {
            if(wasRemote) { JSONObject body=new JSONObject().put("text",prompt);if(attached!=null&&"image".equals(attached.optString("kind")))body.put("attachments",new JSONArray().put(attached));request(endpoint,"/v1/messages",secret,body,true); runOnUiThread(() -> { busy=false; MainActivity view=activeActivity.get(); if(view!=null && !view.destroyed) { view.attachmentController.clear();if(view.remote)view.poll(); } }); }
            else { JSONArray conversation=new JSONArray(snapshot); working[0]=conversation; FolderTools folder=new FolderTools(this,prefs.getString("folder_uri","")); boolean done=false;
                for(int turn=0;turn<12;turn++) { boolean messagesApi="anthropic".equals(provider) || "deepseek-account".equals(authMode); JSONObject data=messagesApi ? MessagesProtocol.request(model,conversation,FolderTools.definitions()) : new JSONObject().put("model",model).put("messages",AttachmentController.apiHistory(conversation)).put("tools",FolderTools.definitions()); if("deepseek-account".equals(authMode)&&!"default".equals(effort)){data.put("thinking",new JSONObject().put("type","enabled"));data.put("output_config",new JSONObject().put("effort",effort));}else if(!messagesApi&&"openai".equals(provider)&&!"default".equals(effort)){data.put("reasoning_effort",effort);}
                    partial.setLength(0); localStreamText="";localStreamThinking="";runOnUiThread(()->publishLocalStream(sentSession,""));
                    JSONObject reply=SseModelClient.request(endpoint,secret,messagesApi?("deepseek-account".equals(authMode)?"deepseek-account":"anthropic"):"",data,(text,thinking)->{partial.setLength(0);partial.append(text);localStreamText=text;localStreamThinking=thinking;long now=System.currentTimeMillis();if(now-lastDraw[0]>=70){lastDraw[0]=now;runOnUiThread(()->publishLocalStream(sentSession,text));}});
                    JSONArray calls=reply.optJSONArray("tool_calls"); if(calls==null||calls.length()==0) { conversation.put(new JSONObject().put("role","assistant").put("content",reply.optString("content",""))); done=true; break; }
                    partial.setLength(0);localStreamText="";localStreamThinking="";runOnUiThread(()->publishLocalStream(sentSession,""));conversation.put(reply); JSONArray started=new JSONArray(conversation.toString());runOnUiThread(() -> publishLocalProgress(sentSession,started,false));
                    for(int i=0;i<calls.length();i++) { JSONObject call=calls.getJSONObject(i), f=call.getJSONObject("function"); String result; try { result=folder.call(f.getString("name"),new JSONObject(f.optString("arguments","{}"))); } catch(Exception e) { result=new JSONObject().put("error",String.valueOf(e.getMessage())).toString(); } conversation.put(new JSONObject().put("role","tool").put("tool_call_id",call.getString("id")).put("content",result)); JSONArray progress=new JSONArray(conversation.toString());runOnUiThread(() -> publishLocalProgress(sentSession,progress,false)); }
                } if(!done) conversation.put(new JSONObject().put("role","assistant").put("content","任务已暂停：工具调用次数达到上限，请发送消息继续。")); JSONArray completed=conversation;localStreamText="";localStreamThinking="";localStreamSession=""; runOnUiThread(() -> {publishLocalStream(sentSession,"");publishLocalProgress(sentSession,completed,true); MainActivity view=activeActivity.get();if(view!=null&&!view.destroyed)view.attachmentController.clear();}); }
        } catch(Exception ex) { if(!wasRemote && working[0]!=null && partial.length()>0)try{working[0].put(new JSONObject().put("role","assistant").put("content",partial.toString()+"\n\n[本次响应未完成]"));}catch(Exception ignored){} localStreamText="";localStreamThinking="";localStreamSession="";runOnUiThread(() -> { if(!wasRemote){publishLocalStream(sentSession,"");if(working[0]!=null)publishLocalProgress(sentSession,working[0],true);} busy=false; MainActivity view=activeActivity.get(); if(wasRemote) { String savedDraft=prefs.getString("draft_remote",""); if(savedDraft.isEmpty()) { prefs.edit().putString("draft_remote",draft).apply(); if(view!=null && !view.destroyed && view.remote && view.input.length()==0) view.input.setText(draft); } } if(view!=null && !view.destroyed) { if(view.remote==wasRemote) view.status.setText("发送失败："+ex.getMessage()); view.toast("发送失败，请检查连接与设置"); } }); } });
    }
    private static void publishLocalStream(String sessionId,String text) { MainActivity view=activeActivity.get();if(view!=null&&!view.destroyed&&!view.remote&&sessionId.equals(view.sessionStore.currentId())){view.renderRemoteProgress(new JSONArray(),text);view.status.setText(text.isEmpty()?"正在思考…":"正在回复…");} }
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
        polling=true; remoteWorker.execute(() -> { try { JSONObject result=request(endpoint,"/v1/state",token,null,true); runOnUiThread(() -> { polling=false; if(remote&&!destroyed) { JSONArray timeline=result.optJSONArray("timeline"), rows=timeline!=null ? timeline : result.optJSONArray("messages"); if(rows==null) rows=new JSONArray(); String key=rows.toString(); if(!key.equals(lastRemoteMessages)) { lastRemoteMessages=key; render(rows); } remoteRunning=result.optBoolean("running"); updateRemoteWorkspace(result.isNull("workspace")?"":result.optString("workspace","")); String currentModel=result.optString("model",""); if(!currentModel.equals(remoteModel)) { remoteModel=currentModel; refreshTabs(); } JSONArray operations=result.optJSONArray("operations"); String stream=result.optString("streamText",""); renderRemoteProgress(timeline!=null ? new JSONArray() : operations,stream); renderRemoteControls(result.optJSONArray("pendingApprovals")); JSONObject last=operations==null || operations.length()==0 ? null : operations.optJSONObject(operations.length()-1); String phase=last!=null && "tool-start".equals(last.optString("type")) ? "正在调用工具…" : stream.isEmpty() ? "正在思考…" : "正在回复…"; status.setText(remoteRunning ? phase : "已连接电脑 · "+result.optString("title","会话")); handler.removeCallbacks(pollTask); handler.postDelayed(pollTask,remoteRunning ? 300 : 2000); } }); }
        catch(Exception ex) { runOnUiThread(() -> { polling=false; if(remote&&!destroyed) { remoteControls.removeAllViews(); status.setText("电脑连接失败："+ex.getMessage()); handler.removeCallbacks(pollTask); handler.postDelayed(pollTask,5000); } }); } });
    }
    private void renderRemoteProgress(JSONArray operations,String stream) {
        if(operations==null) operations=new JSONArray(); String signature=operations.toString()+"\n"+stream; if(signature.equals(lastRemoteProgress)) return; lastRemoteProgress=signature;
        boolean atBottom=isAtBottom(); int oldScroll=scroll.getScrollY(); remoteProgress.removeAllViews();
        ToolEventView tools=new ToolEventView(this,remoteProgress,light,toolExpanded);
        for(int i=0;i<operations.length();i++) { JSONObject operation=operations.optJSONObject(i); if(operation==null) continue; String kind=operation.optString("type"), name=operation.optString("name"), id=operation.optString("toolCallId",operation.optString("id")); if(kind.equals("tool-start"))tools.start(id,name,operation.opt("args")); else if(kind.equals("tool-result"))tools.finish(id,name,operation.opt("result"),operation.optBoolean("error",false)); }
        if(!stream.isEmpty()) { LinearLayout box=new LinearLayout(this); box.setOrientation(LinearLayout.VERTICAL); box.setPadding(dp(2),dp(10),dp(2),dp(10)); TextView label=text("Cortex · 正在回复",13,ACCENT); label.setTypeface(null,Typeface.BOLD); box.addView(label); TextView body=text(stream,16,TEXT); MarkdownRenderer.apply(body,stream,light); body.setPadding(0,dp(6),0,0); box.addView(body); remoteProgress.addView(box); } restoreScroll(atBottom,oldScroll);
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
    private JSONObject request(String base,String route,String token,JSONObject body,boolean computer) throws Exception { return request(base,route,token,body,computer,""); }
    private JSONObject request(String base,String route,String token,JSONObject body,boolean computer,String auth) throws Exception {
        String normalized=base.replaceAll("/+$", "");
        if("deepseek-account".equals(auth) && !"https://api.deepseek.com/anthropic/v1".equals(normalized)) throw new Exception("DeepSeek 账号只能连接官方地址");
        String url=normalized+route; HttpURLConnection c=(HttpURLConnection)new URL(url).openConnection(); c.setConnectTimeout(15000); c.setReadTimeout(body==null?15000:120000); c.setInstanceFollowRedirects(false);
        if("deepseek-account".equals(auth)) { c.setRequestProperty("x-dsh-auth-token",token); c.setRequestProperty("anthropic-version","2023-06-01"); }
        else if("anthropic".equals(auth)) { c.setRequestProperty("x-api-key",token); c.setRequestProperty("anthropic-version","2023-06-01"); }
        else c.setRequestProperty("Authorization","Bearer "+token);
        c.setRequestProperty("Accept","application/json");
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
    // Keep controls outside system bars, cutouts and the on-screen keyboard.
    private void applySafeInsets(View page,int left,int top,int right,int bottom) {
        page.setOnApplyWindowInsetsListener((v,insets)->{
            int l=0,t=0,r=0,b=0;
            if(android.os.Build.VERSION.SDK_INT>=30) {
                android.graphics.Insets bars=insets.getInsets(android.view.WindowInsets.Type.systemBars() | android.view.WindowInsets.Type.displayCutout());
                android.graphics.Insets keyboard=insets.getInsets(android.view.WindowInsets.Type.ime());
                l=bars.left; t=bars.top; r=bars.right; b=Math.max(bars.bottom,keyboard.bottom);
            } else { l=insets.getSystemWindowInsetLeft(); t=insets.getSystemWindowInsetTop(); r=insets.getSystemWindowInsetRight(); b=insets.getSystemWindowInsetBottom(); }
            v.setPadding(dp(left)+l,dp(top)+t,dp(right)+r,dp(bottom)+b); return insets;
        });
        page.requestApplyInsets();
    }
    private void showPage(View page) { showPage(page,true); }
    private void showPage(View page,boolean animate) {
        if(pageChanging) return;
        applySafeInsets(page,18,12,18,10);
        if(!secondaryPage) {
            pageHost=new FrameLayout(this);pageHost.setBackgroundColor(BG);setContentView(pageHost);
            pageHost.addView(mainPage,new FrameLayout.LayoutParams(-1,-1));
            mainPage.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS);
        } else if(currentPage!=null) { currentPage.animate().cancel();pageHost.removeView(currentPage); }
        currentPage=page;secondaryPage=true;pageHost.addView(page,new FrameLayout.LayoutParams(-1,-1));page.requestApplyInsets();
        if(animate){pageChanging=true;page.setTranslationX(getResources().getDisplayMetrics().widthPixels);
            page.animate().translationX(0).setDuration(240).setInterpolator(new android.view.animation.DecelerateInterpolator()).withEndAction(()->pageChanging=false).start();}
        else {page.setTranslationX(0);pageChanging=false;}
    }
    private void leavePage() {
        if(!secondaryPage || pageChanging) return;
        View page=currentPage;pageChanging=true;
        page.animate().translationX(getResources().getDisplayMetrics().widthPixels).setDuration(220).setInterpolator(new android.view.animation.DecelerateInterpolator()).withEndAction(()->{
            pageHost.removeAllViews();pageHost=null;secondaryPage=false;currentPage=null;pageChanging=false;
            mainPage.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_AUTO);setContentView(mainPage);mainPage.requestApplyInsets();refreshTabs();if(remote){handler.removeCallbacks(pollTask);poll();}
        }).start();
    }
    @Override public void onBackPressed() { if(pageChanging)return; if(secondaryPage && computerSettingsPage) settings(); else if(secondaryPage) leavePage(); else super.onBackPressed(); }
    @Override protected void onResume() { super.onResume(); if(modelButton!=null && modelStore!=null) refreshTabs(); }
    private TextView pageButton(String label) { TextView v=control(label,15); v.setPadding(dp(16),0,dp(16),0); v.setGravity(Gravity.CENTER); return v; }
    private void settings() { settings(true); }
    private void settings(boolean animate) {
        computerSettingsPage=false;
        LinearLayout page=new LinearLayout(this); page.setOrientation(LinearLayout.VERTICAL); page.setBackgroundColor(BG);
        LinearLayout head=new LinearLayout(this); head.setGravity(Gravity.CENTER_VERTICAL); page.addView(head,new LinearLayout.LayoutParams(-1,dp(52)));
        ImageButton back=backButton("返回会话"); head.addView(back,new LinearLayout.LayoutParams(dp(40),dp(40))); back.setOnClickListener(v->leavePage());
        TextView heading=text("设置",20,TEXT); heading.setTypeface(null,Typeface.BOLD); heading.setPadding(dp(14),0,0,0); head.addView(heading);
        LinearLayout form=new LinearLayout(this); form.setOrientation(LinearLayout.VERTICAL); LinearLayout.LayoutParams params=new LinearLayout.LayoutParams(-1,-2);params.topMargin=dp(24);page.addView(form,params);
        LinearLayout models=settingsRow(form,"◇","模型设置");models.setOnClickListener(v->modelStore.showManager(()->refreshTabs()));
        LinearLayout computer=settingsRow(form,"▣","电脑连接设置");computer.setOnClickListener(v->computerSettings());
        LinearLayout appearance=settingsRow(form,light?"☾":"☀",light?"切换深色模式":"切换浅色模式");appearance.setOnClickListener(v->{if(busy||controlBusy){toast("请等待当前操作结束");return;}prefs.edit().putBoolean("light_theme",!light).apply();reopenSettingsAfterRecreate=true;recreate();overridePendingTransition(0,0);});
        LinearLayout update=settingsRow(form,"↻","检查更新");TextView info=text("",13,MUTED);info.setPadding(dp(12),dp(6),dp(12),dp(8));info.setVisibility(View.GONE);form.addView(info);
        update.setOnClickListener(v->{update.setEnabled(false);info.setOnClickListener(null);info.setTextColor(MUTED);info.setVisibility(View.VISIBLE);info.setText("正在检查 Android 更新…");
            new Thread(()->{try{String current=getPackageManager().getPackageInfo(getPackageName(),0).versionName;UpdateChecker.Result result=UpdateChecker.check(current);
                runOnUiThread(()->{if(destroyed||currentPage!=page)return;update.setEnabled(true);info.setText(result.message);if(result.url!=null){info.setText(result.message+"\n打开下载页面 ›");info.setTextColor(ACCENT);info.setOnClickListener(view->{try{startActivity(new Intent(Intent.ACTION_VIEW,Uri.parse(result.url)));}catch(Exception e){toast("无法打开下载页面");}});}else{info.setTextColor(MUTED);info.setOnClickListener(null);}});
            }catch(Exception e){runOnUiThread(()->{if(destroyed||currentPage!=page)return;update.setEnabled(true);info.setTextColor(MUTED);info.setOnClickListener(null);info.setText("检查更新失败，请检查网络后重试。");});}},"cortex-update-check").start();});
        showPage(page,animate);
    }
    private LinearLayout settingsRow(LinearLayout parent,String symbol,String label) {
        LinearLayout row=new LinearLayout(this);row.setGravity(Gravity.CENTER_VERTICAL);row.setPadding(dp(14),0,dp(14),0);row.setBackground(rounded(PANEL,14));
        LinearLayout.LayoutParams p=new LinearLayout.LayoutParams(-1,dp(54));p.bottomMargin=dp(10);parent.addView(row,p);
        TextView icon=text(symbol,20,TEXT);icon.setGravity(Gravity.CENTER);row.addView(icon,new LinearLayout.LayoutParams(dp(36),dp(40)));
        TextView name=text(label,16,TEXT);name.setPadding(dp(12),0,0,0);row.addView(name,new LinearLayout.LayoutParams(0,-2,1));TextView arrow=text("›",22,MUTED);row.addView(arrow);return row;
    }
    private ImageButton backButton(String description) { ImageButton back=new ImageButton(this);back.setImageResource(R.drawable.settings_back);back.setColorFilter(TEXT);back.setScaleType(ImageView.ScaleType.CENTER);back.setPadding(0,0,0,0);back.setBackground(rounded(PANEL,22));back.setContentDescription(description);return back; }
    private void computerSettings() {
        computerSettingsPage=true;
        LinearLayout page=new LinearLayout(this); page.setOrientation(LinearLayout.VERTICAL); page.setBackgroundColor(BG);
        LinearLayout head=new LinearLayout(this); head.setGravity(Gravity.CENTER_VERTICAL); page.addView(head,new LinearLayout.LayoutParams(-1,dp(52)));
        ImageButton back=backButton("返回设置"); head.addView(back,new LinearLayout.LayoutParams(dp(44),dp(44))); back.setOnClickListener(v->settings());
        TextView heading=text("电脑连接设置",20,TEXT); heading.setTypeface(null,Typeface.BOLD); heading.setPadding(dp(16),0,0,0); head.addView(heading);
        ScrollView settingsScroll=new ScrollView(this); settingsScroll.setFillViewport(true); page.addView(settingsScroll,new LinearLayout.LayoutParams(-1,0,1));
        LinearLayout form=new LinearLayout(this); form.setOrientation(LinearLayout.VERTICAL); form.setPadding(0,dp(20),0,dp(16)); settingsScroll.addView(form);
        TextView hint=text("电脑远程配对",17,TEXT); hint.setTypeface(null,Typeface.BOLD); hint.setPadding(0,dp(28),0,dp(10)); form.addView(hint);
        TextView description=text("在电脑端开启手机远程连接后，扫码或手动填写地址、证书指纹和令牌。",13,MUTED); form.addView(description);
        TextView scan=pageButton("扫描电脑配对二维码"); LinearLayout.LayoutParams scanParams=new LinearLayout.LayoutParams(-1,dp(48));scanParams.topMargin=dp(14);form.addView(scan,scanParams);scan.setOnClickListener(v->{try{startActivityForResult(new Intent(this,PairingScanActivity.class),604);}catch(Exception e){toast("无法打开扫码，请手动填写");}});
        EditText computer=field(form,"电脑地址（https://地址:端口）",prefs.getString("remote_url",""),false), fingerprint=field(form,"电脑证书 SHA-256 指纹",prefs.getString("remote_fingerprint",""),false), token=field(form,"电脑配对令牌（留空保持原值）","",true);
        pairingPage=page;pairingAddress=computer;pairingFingerprint=fingerprint;pairingToken=token;
        TextView save=pageButton("保存连接"); LinearLayout.LayoutParams sp=new LinearLayout.LayoutParams(-1,dp(50)); sp.topMargin=dp(24); form.addView(save,sp);
        save.setOnClickListener(v->{ try { if(!computer.getText().toString().trim().isEmpty()) validateUrl(computer.getText().toString().trim(),true); String fp=fingerprint.getText().toString().replace(":","").replace(" ",""); if(!fp.isEmpty()&&!fp.matches("(?i)[0-9a-f]{64}")) throw new Exception("证书指纹必须为 64 位十六进制字符"); if(token.length()>0) writeSecret("remote_token",token.getText().toString()); prefs.edit().putString("remote_url",computer.getText().toString().trim()).putString("remote_fingerprint",fp).apply(); toast("设置已保存"); leavePage(); } catch(Exception ex) { toast("设置未保存："+ex.getMessage()); } });
        showPage(page);
    }
    @Override public void onRequestPermissionsResult(int requestCode,String[] permissions,int[] results){super.onRequestPermissionsResult(requestCode,permissions,results);if(requestCode==605&&attachmentController!=null)attachmentController.cameraPermissionResult(results);}
    private void renderAttachmentPreview() { if(attachmentPreview==null)return;attachmentPreview.removeAllViews();if(!attachmentController.hasItem())return;TextView label=text("附件："+attachmentController.name()+"   ✕",13,TEXT);label.setPadding(dp(8),dp(5),dp(8),dp(5));attachmentPreview.addView(label);label.setOnClickListener(v->{if(!busy)attachmentController.clear();}); }
    @Override protected void onActivityResult(int requestCode,int resultCode,Intent data) { super.onActivityResult(requestCode,resultCode,data);if(requestCode==604){if(resultCode==RESULT_OK&&data!=null&&currentPage==pairingPage&&computerSettingsPage){try{PairingPayload parsed=PairingPayload.parse(data.getStringExtra("pairing"));pairingAddress.setText(parsed.url);pairingFingerprint.setText(parsed.fingerprint);pairingToken.setText(parsed.token);toast("已读取配对信息，请核对后保存");}catch(Exception e){toast("二维码无效，连接设置未更改");}}return;} if(attachmentController!=null&&attachmentController.result(requestCode,resultCode,data))return; if(requestCode==41&&resultCode==RESULT_OK&&data!=null&&data.getData()!=null) { Uri uri=data.getData(); int flags=data.getFlags() & (Intent.FLAG_GRANT_READ_URI_PERMISSION|Intent.FLAG_GRANT_WRITE_URI_PERMISSION); if(flags!=(Intent.FLAG_GRANT_READ_URI_PERMISSION|Intent.FLAG_GRANT_WRITE_URI_PERMISSION)) { toast("请选择允许读取和写入的文件夹"); return; } try { getContentResolver().takePersistableUriPermission(uri,flags); String selectedName=folderName(uri);prefs.edit().putString("folder_uri",uri.toString()).putString("folder_name",selectedName).apply();refreshTabs();toast("文件夹已授权"); } catch(Exception e) { toast("文件夹授权失败"); } } }
    private SecretKey key() throws Exception { KeyStore ks=KeyStore.getInstance("AndroidKeyStore"); ks.load(null); if(!ks.containsAlias("cortex_secrets")) { KeyGenerator g=KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES,"AndroidKeyStore"); g.init(new KeyGenParameterSpec.Builder("cortex_secrets",KeyProperties.PURPOSE_ENCRYPT|KeyProperties.PURPOSE_DECRYPT).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build()); g.generateKey(); } return (SecretKey)ks.getKey("cortex_secrets",null); }
    private void writeSecret(String name,String value) throws Exception { Cipher c=Cipher.getInstance("AES/GCM/NoPadding"); c.init(Cipher.ENCRYPT_MODE,key()); byte[] encrypted=c.doFinal(value.getBytes(StandardCharsets.UTF_8)); prefs.edit().putString(name,Base64.encodeToString(c.getIV(),Base64.NO_WRAP)+":"+Base64.encodeToString(encrypted,Base64.NO_WRAP)).apply(); }
    private String readSecret(String name) throws Exception { String v=prefs.getString(name,""); if(v.isEmpty()) return ""; String[] p=v.split(":",2); Cipher c=Cipher.getInstance("AES/GCM/NoPadding"); c.init(Cipher.DECRYPT_MODE,key(),new GCMParameterSpec(128,Base64.decode(p[0],Base64.NO_WRAP))); return new String(c.doFinal(Base64.decode(p[1],Base64.NO_WRAP)),StandardCharsets.UTF_8); }
    private void toast(String s) { Toast.makeText(this,s,Toast.LENGTH_LONG).show(); }
    @Override protected void onDestroy() { destroyed=true; if(activeActivity.get()==this) activeActivity.clear(); handler.removeCallbacksAndMessages(null); worker.shutdown(); remoteWorker.shutdown(); super.onDestroy(); }
}
