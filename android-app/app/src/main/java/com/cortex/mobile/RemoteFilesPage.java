package com.cortex.mobile;

import android.app.Activity;
import android.graphics.Typeface;
import android.view.Gravity;
import android.view.View;
import android.widget.*;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.concurrent.ExecutorService;

/** Browses only the explicitly paired computer, never a third-party browser. */
final class RemoteFilesPage {
    interface Actions {
        JSONObject request(String route, JSONObject body) throws Exception;
        void download(String path);
        void close();
        void projectOpened(String path);
    }
    private final Activity activity; private final ExecutorService worker; private final Actions actions;
    private final int bg, panel, text, muted; private final LinearLayout root, list; private final EditText path;
    private final TextView info; private String current="";
    private int generation;
    RemoteFilesPage(Activity activity, ExecutorService worker, Actions actions, int bg, int panel, int text, int muted) {
        this.activity=activity;this.worker=worker;this.actions=actions;this.bg=bg;this.panel=panel;this.text=text;this.muted=muted;
        root=new LinearLayout(activity);root.setOrientation(LinearLayout.VERTICAL);root.setPadding(dp(18),dp(18),dp(18),dp(14));root.setBackgroundColor(bg);
        root.setOnApplyWindowInsetsListener((v,in)->{v.setPadding(dp(18)+in.getSystemWindowInsetLeft(),dp(18)+in.getSystemWindowInsetTop(),dp(18)+in.getSystemWindowInsetRight(),dp(14)+in.getSystemWindowInsetBottom());return in.consumeSystemWindowInsets();});
        LinearLayout header=new LinearLayout(activity);header.setGravity(Gravity.CENTER_VERTICAL);root.addView(header);
        Button back=button("‹");header.addView(back,new LinearLayout.LayoutParams(dp(48),dp(48)));back.setOnClickListener(v->actions.close());
        TextView title=label("电脑文件",20,text);title.setTypeface(null,Typeface.BOLD);title.setPadding(dp(12),0,0,0);header.addView(title);
        path=new EditText(activity);path.setSingleLine(true);path.setTextColor(text);path.setHintTextColor(muted);path.setHint("电脑绝对路径（留空显示磁盘）");path.setTextSize(14);root.addView(path);
        LinearLayout nav=new LinearLayout(activity);root.addView(nav);Button open=button("打开路径"), parent=button("上一级"), create=button("新建项目");nav.addView(open,new LinearLayout.LayoutParams(0,dp(48),1));nav.addView(parent,new LinearLayout.LayoutParams(0,dp(48),1));nav.addView(create,new LinearLayout.LayoutParams(0,dp(48),1));
        open.setOnClickListener(v->load(path.getText().toString().trim()));parent.setOnClickListener(v->load(parentPath));create.setOnClickListener(v->createProject());
        info=label("正在读取电脑文件…",13,muted);root.addView(info);
        ScrollView scroll=new ScrollView(activity);root.addView(scroll,new LinearLayout.LayoutParams(-1,0,1));list=new LinearLayout(activity);list.setOrientation(LinearLayout.VERTICAL);scroll.addView(list);
        load("");
    }
    View view(){return root;}
    private String parentPath="";
    private int dp(int n){return (int)(n*activity.getResources().getDisplayMetrics().density+.5f);}
    private TextView label(String value,int size,int color){TextView t=new TextView(activity);t.setText(value);t.setTextSize(size);t.setTextColor(color);return t;}
    private Button button(String value){Button b=new Button(activity);b.setText(value);b.setAllCaps(false);b.setTextColor(text);b.setBackgroundColor(panel);return b;}
    private JSONObject obj(String key,String value){try{return new JSONObject().put(key,value);}catch(Exception e){throw new IllegalArgumentException(e);}}
    private void load(String target){
        final int ticket=++generation;info.setText("正在读取…");
        worker.execute(()->{try{JSONObject data=actions.request("/v1/files/list",obj("path",target));activity.runOnUiThread(()->{
            if(ticket!=generation||activity.isFinishing())return;current=data.optString("path",target);parentPath=data.optString("parent","");if("null".equals(parentPath))parentPath="";path.setText(current);list.removeAllViews();JSONArray entries=data.optJSONArray("entries");
            if(entries!=null)for(int i=0;i<entries.length();i++){JSONObject item=entries.optJSONObject(i);if(item==null)continue;String file=item.optString("path"),name=item.optString("name"),type=item.optString("type");boolean dir="directory".equals(type)||"dir".equals(type)||"drive".equals(type);Button row=button((dir?"📁  ":"📄  ")+name);row.setGravity(Gravity.CENTER_VERTICAL|Gravity.START);LinearLayout.LayoutParams lp=new LinearLayout.LayoutParams(-1,dp(50));lp.topMargin=dp(5);list.addView(row,lp);row.setOnClickListener(v->{if(dir)load(file);else showFile(file);});}
            info.setText(entries==null||entries.length()==0?"没有可显示的文件":"选择文件夹或文件");
        });}catch(Exception e){activity.runOnUiThread(()->{if(ticket==generation)info.setText("读取失败："+e.getMessage());});}});
    }
    private void createProject(){
        if(current.isEmpty()){info.setText("请先选择新项目所在的文件夹");return;}
        EditText name=new EditText(activity);name.setSingleLine(true);name.setHint("项目文件夹名称");
        new android.app.AlertDialog.Builder(activity).setTitle("新建电脑项目").setView(name).setNegativeButton("取消",null).setPositiveButton("创建",(d,w)->{
            String n=name.getText().toString().trim();if(n.isEmpty()||n.contains("/")||n.contains("\\")||n.equals(".")||n.equals("..")){info.setText("请输入有效的文件夹名称");return;}
            String separator=current.contains("\\")?"\\":"/";String target=current.endsWith("/")||current.endsWith("\\")?current+n:current+separator+n;
            info.setText("正在创建项目…");worker.execute(()->{try{JSONObject result=actions.request("/v1/files/project",obj("path",target));activity.runOnUiThread(()->actions.projectOpened(result.optString("path",target)));}catch(Exception e){activity.runOnUiThread(()->info.setText("创建失败："+e.getMessage()));}});
        }).show();
    }
    private void showFile(String file){
        info.setText("正在读取文件…");worker.execute(()->{try{JSONObject data=actions.request("/v1/files/read",obj("path",file));String content=data.getString("content"),version=data.getString("version");activity.runOnUiThread(()->editFile(file,content,version));}catch(Exception e){activity.runOnUiThread(()->{info.setText("无法作为文本打开，可直接下载："+e.getMessage());new android.app.AlertDialog.Builder(activity).setMessage("无法编辑此文件，是否下载？").setNegativeButton("取消",null).setPositiveButton("下载",(d,w)->actions.download(file)).show();});}});
    }
    private void editFile(String file,String content,String version){
        EditText editor=new EditText(activity);editor.setText(content);editor.setTextSize(14);editor.setGravity(Gravity.TOP|Gravity.START);editor.setMinLines(8);editor.setMaxLines(18);
        android.app.AlertDialog dialog=new android.app.AlertDialog.Builder(activity).setTitle(file).setView(editor).setNeutralButton("下载",(d,w)->actions.download(file)).setNegativeButton("取消",null).setPositiveButton("保存",null).create();
        dialog.setOnShowListener(v->dialog.getButton(android.app.AlertDialog.BUTTON_POSITIVE).setOnClickListener(view->{
            String changed=editor.getText().toString();Button save=dialog.getButton(android.app.AlertDialog.BUTTON_POSITIVE);save.setEnabled(false);info.setText("正在保存…");worker.execute(()->{try{JSONObject body=obj("path",file).put("content",changed).put("version",version);actions.request("/v1/files/write",body);activity.runOnUiThread(()->{info.setText("已保存");dialog.dismiss();});}catch(Exception e){activity.runOnUiThread(()->{save.setEnabled(true);info.setText("保存失败："+e.getMessage());Toast.makeText(activity,"保存失败，请检查文件是否已被修改；文本仍保留",Toast.LENGTH_LONG).show();});}});
        }));dialog.show();
    }
}
