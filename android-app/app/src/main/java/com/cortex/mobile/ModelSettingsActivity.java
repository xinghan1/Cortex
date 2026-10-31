package com.cortex.mobile;

import android.app.Activity;
import android.os.Bundle;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.view.Gravity;
import android.view.View;
import android.view.WindowInsets;
import android.widget.*;
import org.json.JSONArray;
import org.json.JSONObject;
import java.net.URL;
import java.net.HttpURLConnection;
import java.io.InputStream;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.UUID;

/** Model configuration and catalog; API credentials are stored by ModelStore in Android Keystore. */
public class ModelSettingsActivity extends Activity {
    private static final String[] PROVIDERS={"OpenAI","DeepSeek","Gemini","Kimi","GLM","豆包","Anthropic","中转站"};
    private static final String[] IDS={"openai","deepseek","gemini","kimi","glm","doubao","anthropic","relay"};
    private static final String[] URLS={"https://api.openai.com/v1","https://api.deepseek.com/v1","https://generativelanguage.googleapis.com/v1beta/openai","https://api.moonshot.cn/v1","https://open.bigmodel.cn/api/paas/v4","https://ark.cn-beijing.volces.com/api/v3","https://api.anthropic.com/v1",""};
    private ModelStore store; private SharedPreferences prefs; private boolean light,loading;
    private int bg,panel,text,muted,accent; private String profileId="", savedKeyId="",accountToken=""; private int lastProvider=-1,lastMode=-1; private long authGeneration;
    private Spinner profiles,provider,mode,catalog; private EditText title,base,key; private TextView info,login; private LinearLayout root;
    private final CatalogSelection selection=new CatalogSelection(); private String savedProvider="",savedUrl="",savedMode="";
    private int dp(float n){return (int)(n*getResources().getDisplayMetrics().density+.5f);}
    private GradientDrawable shape(int color,int radius){GradientDrawable d=new GradientDrawable();d.setColor(color);d.setCornerRadius(dp(radius));return d;}
    private TextView label(String s,int size,int color){TextView t=new TextView(this);t.setText(s);t.setTextSize(size);t.setTextColor(color);return t;}
    private void space(int n){View v=new View(this);root.addView(v,new LinearLayout.LayoutParams(1,dp(n)));}
    private void heading(String s){TextView v=label(s,14,muted);v.setPadding(0,dp(12),0,dp(6));root.addView(v);}
    private Spinner spinner(String[] values){ Spinner s=new Spinner(this,Spinner.MODE_DROPDOWN);s.setAdapter(RoundedSpinner.adapter(this,values,light));RoundedSpinner.style(s,light);root.addView(s,new LinearLayout.LayoutParams(-1,dp(50)));return s; }
    private EditText field(String hint,boolean secret){EditText e=new EditText(this);e.setSingleLine(true);e.setTextColor(text);e.setHintTextColor(muted);e.setTextSize(15);e.setHint(hint);e.setPadding(dp(14),0,dp(14),0);e.setBackground(shape(panel,12));if(secret)e.setInputType(129);root.addView(e,new LinearLayout.LayoutParams(-1,dp(50)));return e;}
    private TextView button(String s,boolean primary){TextView v=label(s,15,primary?(light?Color.WHITE:Color.BLACK):text);v.setGravity(Gravity.CENTER);v.setBackground(shape(primary?accent:panel,14));root.addView(v,new LinearLayout.LayoutParams(-1,dp(48)));return v;}
    @Override public void onCreate(Bundle b){
        light=getSharedPreferences("cortex",MODE_PRIVATE).getBoolean("light_theme",false);setTheme(light?android.R.style.Theme_Material_Light_NoActionBar:android.R.style.Theme_Material_NoActionBar);super.onCreate(b);
        prefs=getSharedPreferences("cortex",MODE_PRIVATE);store=new ModelStore(this,prefs); bg=light?0xfff7f7f8:0xff101113; panel=light?0xffe9eaed:0xff242528;text=light?0xff181a1f:0xfff2f2f3;muted=light?0xff70747d:0xff95979d;accent=light?0xff252a35:0xffe6ecf8;
        getWindow().setStatusBarColor(bg);getWindow().setNavigationBarColor(bg);if(light)getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR|View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
        ScrollView scroll=new ScrollView(this);scroll.setFillViewport(true);scroll.setBackgroundColor(bg);root=new LinearLayout(this);root.setOrientation(LinearLayout.VERTICAL);root.setPadding(dp(20),dp(16),dp(20),dp(24));scroll.addView(root);setContentView(scroll);
        scroll.setOnApplyWindowInsetsListener((v,in)->{ v.setPadding(in.getSystemWindowInsetLeft(),in.getSystemWindowInsetTop(),in.getSystemWindowInsetRight(),in.getSystemWindowInsetBottom());return in.consumeSystemWindowInsets(); });scroll.requestApplyInsets();
        LinearLayout header=new LinearLayout(this);header.setGravity(Gravity.CENTER_VERTICAL);root.addView(header);TextView back=label("‹",34,text);back.setGravity(Gravity.CENTER);header.addView(back,new LinearLayout.LayoutParams(dp(46),dp(48)));back.setOnClickListener(v->finish());TextView h=label("模型与连接",22,text);h.setTypeface(null,Typeface.BOLD);header.addView(h);
        heading("已保存的配置");profiles=spinner(new String[]{"＋ 新建配置"});
        heading("模型服务商");provider=spinner(PROVIDERS);
        heading("连接方式");mode=spinner(new String[]{"API Key","账号登录（DeepSeek）"});space(8);login=button("登录 DeepSeek 账号",false);login.setVisibility(View.GONE);login.setOnClickListener(v->{final long generation=authGeneration;DeepSeekAccount.signIn(this,new DeepSeekAccount.Callback(){public void onSuccess(String token){if(isFinishing()||generation!=authGeneration||provider.getSelectedItemPosition()!=1||mode.getSelectedItemPosition()!=1)return;accountToken=token;authGeneration++;selection.invalidate(false);renderCatalog();info.setText("DeepSeek 账号已授权，请刷新模型目录并保存。");}public void onError(String message){if(!isFinishing()&&generation==authGeneration)info.setText(message);}});});
        heading("配置名称");title=field("例如：我的 GPT",false);
        heading("Base URL");base=field("https://…",false);
        heading("API Key");key=field("填写密钥，留空保留原值",true);
        heading("模型目录");catalog=spinner(new String[]{"请先刷新模型目录"});space(8);button("刷新模型目录",false).setOnClickListener(v->loadCatalog());
        info=label("模型接口使用 HTTPS；密钥加密保存在本机。",13,muted);info.setPadding(0,dp(10),0,dp(8));root.addView(info);
        space(8);button("保存并使用",true).setOnClickListener(v->save());space(12);
        profiles.setOnItemSelectedListener(new android.widget.AdapterView.OnItemSelectedListener(){public void onNothingSelected(android.widget.AdapterView<?> p){} public void onItemSelected(android.widget.AdapterView<?> p,View v,int pos,long id){ if(loading)return; JSONArray a=store.allProfiles(); if(pos==a.length()){loadProfile(null);}else loadProfile(a.optJSONObject(pos)); }});
        provider.setOnItemSelectedListener(new android.widget.AdapterView.OnItemSelectedListener(){ public void onNothingSelected(android.widget.AdapterView<?> p){} public void onItemSelected(android.widget.AdapterView<?> p,View v,int pos,long id){ if(!loading&&pos!=lastProvider){authGeneration++;lastProvider=pos;savedKeyId="";accountToken="";key.setText("");base.setText(URLS[pos]); if(title.getText().toString().trim().isEmpty())title.setText(PROVIDERS[pos]);updateMode();selection.invalidate(false);renderCatalog();} }});
        mode.setOnItemSelectedListener(new android.widget.AdapterView.OnItemSelectedListener(){public void onNothingSelected(android.widget.AdapterView<?> p){} public void onItemSelected(android.widget.AdapterView<?> p,View v,int pos,long id){if(!loading&&pos!=lastMode){authGeneration++;lastMode=pos;accountToken="";savedKeyId="";key.setText("");updateMode();selection.invalidate(false);renderCatalog();}}});
        catalog.setOnItemSelectedListener(new android.widget.AdapterView.OnItemSelectedListener(){public void onNothingSelected(android.widget.AdapterView<?> p){} public void onItemSelected(android.widget.AdapterView<?> p,View v,int pos,long id){selection.select(pos>0?String.valueOf(p.getItemAtPosition(pos)):"");}});
        android.text.TextWatcher connectionChanges=new android.text.TextWatcher(){public void beforeTextChanged(CharSequence s,int start,int count,int after){} public void onTextChanged(CharSequence s,int start,int before,int count){if(!loading){authGeneration++;selection.invalidate(canKeepSaved());renderCatalog();}}public void afterTextChanged(android.text.Editable e){}};
        base.addTextChangedListener(connectionChanges);key.addTextChangedListener(connectionChanges);
        reloadProfiles();
    }
    private void reloadProfiles(){JSONArray a=store.allProfiles();String[] names=new String[a.length()+1];JSONObject selected=store.selectedProfile();int chosen=a.length();for(int i=0;i<a.length();i++){JSONObject o=a.optJSONObject(i);names[i]=o.optString("name")+" · "+o.optString("model");if(selected!=null&&o.optString("id").equals(selected.optString("id")))chosen=i;}names[a.length()]="＋ 新建配置";loading=true;profiles.setAdapter(RoundedSpinner.adapter(this,names,light));profiles.setSelection(chosen);loading=false;loadProfile(chosen<a.length()?a.optJSONObject(chosen):null);}
    private void loadProfile(JSONObject o){authGeneration++;loading=true;profileId=o==null?"":o.optString("id");savedKeyId=profileId;accountToken="";String p=o==null?"openai":o.optString("provider","relay");int i=0;for(int j=0;j<IDS.length;j++)if(IDS[j].equals(p))i=j;lastProvider=i;lastMode=o!=null&&"deepseek-account".equals(o.optString("authMode"))?1:0;savedProvider=IDS[i];savedMode=lastMode==1?"deepseek-account":"apiKey";savedUrl=o==null?"":o.optString("url").replaceAll("/+$","");provider.setSelection(i);mode.setSelection(lastMode);title.setText(o==null?"":o.optString("name"));base.setText(o==null?URLS[i]:o.optString("url"));key.setText("");updateMode();ArrayList<String> cached=new ArrayList<>();JSONArray savedCatalog=o==null?null:o.optJSONArray("catalog");if(savedCatalog!=null)for(int j=0;j<savedCatalog.length();j++)cached.add(savedCatalog.optString(j));selection.load(o==null?"":o.optString("model"),o!=null&&canKeepSaved(),cached);renderCatalog();loading=false;}
    private boolean canKeepSaved(){return !profileId.isEmpty()&&profileId.equals(savedKeyId)&&savedProvider.equals(IDS[provider.getSelectedItemPosition()])&&savedMode.equals(mode.getSelectedItemPosition()==1?"deepseek-account":"apiKey")&&savedUrl.equals(base.getText().toString().trim().replaceAll("/+$",""))&&key.length()==0&&accountToken.isEmpty();}
    private void renderCatalog(){java.util.List<String> ids=selection.models();ArrayList<String> labels=new ArrayList<>();labels.add(ids.isEmpty()?"请先刷新模型目录":"请选择模型");labels.addAll(ids);catalog.setAdapter(RoundedSpinner.adapter(this,labels,light));int index=ids.indexOf(selection.selected());catalog.setSelection(index<0?0:index+1);}
    private void updateMode(){boolean account=mode.getSelectedItemPosition()==1;boolean deep=provider.getSelectedItemPosition()==1;login.setVisibility(account&&deep?View.VISIBLE:View.GONE);key.setEnabled(!account);base.setEnabled(!account);if(account&&deep)base.setText("https://api.deepseek.com/anthropic/v1");else if(!account&&base.getText().toString().contains("api.deepseek.com/anthropic/v1"))base.setText(URLS[provider.getSelectedItemPosition()]);if(account&&!deep)info.setText("此服务商的手机账号登录尚未实现，可改用 API Key 或连接电脑。");}
    private String endpoint() throws Exception {String value=base.getText().toString().trim();URL u=new URL(value);if(!"https".equalsIgnoreCase(u.getProtocol())||u.getHost().isEmpty()||u.getUserInfo()!=null||u.getQuery()!=null||u.getRef()!=null)throw new Exception("请输入有效的 HTTPS Base URL");return value.replaceAll("/+$","");}
    private String secret() throws Exception {String s=mode.getSelectedItemPosition()==1?accountToken:key.getText().toString();if(s.isEmpty()&&!savedKeyId.isEmpty())s=store.keyFor(savedKeyId);if(s.isEmpty())throw new Exception(mode.getSelectedItemPosition()==1?"请先登录 DeepSeek 账号":"请填写 API Key");return s;}
    private void save(){try{boolean account=mode.getSelectedItemPosition()==1;if(account&&provider.getSelectedItemPosition()!=1)throw new Exception("该服务商的手机账号登录尚未实现，请使用 API Key 或连接电脑");String url=account?"https://api.deepseek.com/anthropic/v1":endpoint(),s=secret(),m=selection.selected(),n=title.getText().toString().trim();if(m.isEmpty())throw new Exception("请刷新模型目录并选择模型");if(n.isEmpty())n=PROVIDERS[provider.getSelectedItemPosition()];if(profileId.isEmpty())profileId=UUID.randomUUID().toString();JSONObject o=new JSONObject().put("id",profileId).put("name",n).put("model",m).put("url",url).put("provider",IDS[provider.getSelectedItemPosition()]).put("authMode",account?"deepseek-account":"apiKey").put("catalog",new JSONArray(selection.models()));store.saveProfile(o,s);finish();}catch(Exception e){info.setText("无法保存："+e.getMessage());}}
    private void loadCatalog() {
        try {
            final boolean account=mode.getSelectedItemPosition()==1;
            if(account && provider.getSelectedItemPosition()!=1) throw new Exception("此服务商账号暂不可用");
            final String url=account ? "https://api.deepseek.com/anthropic/v1" : endpoint();
            final String secret=secret(), providerId=IDS[provider.getSelectedItemPosition()]; final long generation=authGeneration, ticket=selection.begin();
            info.setText("正在获取模型目录…");
            new Thread(() -> {
                HttpURLConnection c=null;
                try {
                    JSONArray rows;
                    if(account) rows=DeepSeekAccount.listModels(secret);
                    else {
                        c=(HttpURLConnection)new URL(url+"/models").openConnection();c.setInstanceFollowRedirects(false);c.setConnectTimeout(15000);c.setReadTimeout(20000);
                        if("anthropic".equals(providerId)){c.setRequestProperty("x-api-key",secret);c.setRequestProperty("anthropic-version","2023-06-01");}else c.setRequestProperty("Authorization","Bearer "+secret);
                        int status=c.getResponseCode();if(status<200||status>=300)throw new Exception("HTTP "+status);
                        ByteArrayOutputStream out=new ByteArrayOutputStream();try(InputStream in=c.getInputStream()){byte[] buf=new byte[8192];int n;while((n=in.read(buf))!=-1){if(out.size()+n>2*1024*1024)throw new Exception("模型目录过大");out.write(buf,0,n);}}
                        rows=new JSONObject(new String(out.toByteArray(),StandardCharsets.UTF_8)).optJSONArray("data");if(rows==null)throw new Exception("返回的模型目录格式不受支持");
                    }
                    ArrayList<String> ids=new ArrayList<>();
                    for(int i=0;i<rows.length()&&i<500;i++){JSONObject row=rows.optJSONObject(i);String id=account?rows.optString(i,""):row==null?"":row.optString("id","");if(!id.isEmpty())ids.add(id);}
                    runOnUiThread(()->{if(isFinishing()||generation!=authGeneration||!providerId.equals(IDS[provider.getSelectedItemPosition()])||account!=(mode.getSelectedItemPosition()==1)||!selection.apply(ticket,ids))return;renderCatalog();info.setText(ids.isEmpty()?"目录未返回可选模型。":"已获取 "+ids.size()+" 个模型，请从目录选择。");});
                } catch(Exception e) {runOnUiThread(()->{if(!isFinishing()&&generation==authGeneration)info.setText("获取失败："+e.getMessage()+"；请检查连接后重试。");});} finally {if(c!=null)c.disconnect();}
            },"cortex-model-catalog").start();
        } catch(Exception e) {info.setText("获取失败："+e.getMessage());}
    }
}
