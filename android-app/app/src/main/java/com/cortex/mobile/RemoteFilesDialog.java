package com.cortex.mobile;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.Dialog;
import android.graphics.Typeface;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import java.util.List;

/** UI only. A transport adapter must be supplied after the desktop protocol is agreed. */
final class RemoteFilesDialog {
    interface Result<T> { void complete(T value, String error); }
    interface Backend {
        void list(String path, Result<Directory> result);
        void read(String path, Result<FileText> result);
        void save(String path, String text, String revision, Result<FileText> result);
        void createProject(String parent, String name, Result<String> result);
        void download(String path, Result<Void> result);
    }
    static final class Entry {
        final String name, path; final boolean directory;
        Entry(String name, String path, boolean directory) { this.name=name; this.path=path; this.directory=directory; }
    }
    static final class Directory {
        final String path, parent; final List<Entry> entries;
        Directory(String path, String parent, List<Entry> entries) { this.path=path; this.parent=parent; this.entries=entries; }
    }
    static final class FileText {
        final String text, revision;
        FileText(String text, String revision) { this.text=text; this.revision=revision; }
    }

    private final Activity activity; private final Backend backend;
    private final Dialog dialog; private final LinearLayout root, list;
    private final EditText path; private final TextView status; private final Button up;
    private String parent; private boolean loading; private int generation;

    RemoteFilesDialog(Activity activity, Backend backend) {
        this.activity=activity; this.backend=backend; dialog=new Dialog(activity);
        root=new LinearLayout(activity); root.setOrientation(LinearLayout.VERTICAL); root.setPadding(dp(16),dp(16),dp(16),dp(16));
        TextView title=new TextView(activity); title.setText("电脑文件"); title.setTextSize(20); title.setTypeface(null,Typeface.BOLD); root.addView(title);
        TextView warning=new TextView(activity); warning.setText("访问的是电脑路径。修改和新建操作会影响电脑上的文件。"); root.addView(warning);
        LinearLayout address=new LinearLayout(activity); address.setGravity(Gravity.CENTER_VERTICAL); root.addView(address);
        path=new EditText(activity); path.setSingleLine(true); path.setHint("输入电脑上的绝对路径"); path.setInputType(android.text.InputType.TYPE_CLASS_TEXT | android.text.InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS); address.addView(path,new LinearLayout.LayoutParams(0,-2,1));
        Button go=new Button(activity); go.setText("前往"); address.addView(go); go.setOnClickListener(v->open(path.getText().toString().trim()));
        LinearLayout actions=new LinearLayout(activity); root.addView(actions);
        up=new Button(activity); up.setText("上一级"); actions.addView(up,new LinearLayout.LayoutParams(0,-2,1)); up.setOnClickListener(v->{if(parent!=null)open(parent);});
        Button create=new Button(activity); create.setText("新建项目"); actions.addView(create,new LinearLayout.LayoutParams(0,-2,1)); create.setOnClickListener(v->createProject());
        status=new TextView(activity); root.addView(status);
        ScrollView scroll=new ScrollView(activity); root.addView(scroll,new LinearLayout.LayoutParams(-1,0,1)); list=new LinearLayout(activity); list.setOrientation(LinearLayout.VERTICAL); scroll.addView(list);
        Button close=new Button(activity); close.setText("关闭"); root.addView(close); close.setOnClickListener(v->dialog.dismiss());
        dialog.setContentView(root); dialog.setOnDismissListener(d->generation++);
    }
    void show(String initialPath) {
        dialog.show(); WindowManager.LayoutParams p=new WindowManager.LayoutParams(); p.copyFrom(dialog.getWindow().getAttributes()); p.width=activity.getResources().getDisplayMetrics().widthPixels-dp(24); p.height=(int)(activity.getResources().getDisplayMetrics().heightPixels*0.85); dialog.getWindow().setAttributes(p);
        if(initialPath!=null && !initialPath.isEmpty()) open(initialPath); else {up.setEnabled(false); status.setText("请输入电脑上的绝对路径后前往。");}
    }
    private int dp(int n) { return (int)(n*activity.getResources().getDisplayMetrics().density+0.5f); }
    private void open(String target) {
        if(loading || target.isEmpty()) { if(target.isEmpty()) status.setText("请输入路径"); return; }
        loading=true; status.setText("正在读取目录…"); final int request=++generation;
        backend.list(target,(dir,error)->activity.runOnUiThread(()->{
            if(request!=generation || !dialog.isShowing())return; loading=false;
            if(error!=null || dir==null) { status.setText("读取失败："+(error==null?"无结果":error)); return; }
            path.setText(dir.path); parent=dir.parent; up.setEnabled(parent!=null && !parent.isEmpty()); list.removeAllViews();
            status.setText(dir.entries.isEmpty()?"空目录":"选择文件夹或文件");
            for(Entry entry:dir.entries) { Button row=new Button(activity); row.setAllCaps(false); row.setGravity(Gravity.START|Gravity.CENTER_VERTICAL); row.setText((entry.directory?"📁  ":"📄  ")+entry.name); list.addView(row,new LinearLayout.LayoutParams(-1,-2)); row.setOnClickListener(v->{if(entry.directory)open(entry.path);else fileActions(entry);}); }
        }));
    }
    private void createProject() {
        if(loading)return; final String directory=path.getText().toString().trim(); if(directory.isEmpty()){status.setText("请先打开目标目录");return;}
        EditText name=new EditText(activity); name.setSingleLine(true); name.setHint("项目名称");
        new AlertDialog.Builder(activity).setTitle("在电脑新建项目").setMessage("目标目录："+directory).setView(name).setNegativeButton("取消",null).setPositiveButton("创建",(d,w)->{
            String value=name.getText().toString().trim(); if(value.isEmpty() || value.equals(".") || value.equals("..") || value.contains("/") || value.contains("\\")){status.setText("请输入有效的单级项目名称");return;}
            loading=true; status.setText("正在创建项目…"); final int request=++generation;
            backend.createProject(directory,value,(created,error)->activity.runOnUiThread(()->{if(request!=generation || !dialog.isShowing())return; loading=false; if(error!=null)status.setText("创建失败："+error); else {status.setText("项目已创建："+created); open(directory);} }));
        }).show();
    }
    private void fileActions(Entry entry) {
        new AlertDialog.Builder(activity).setTitle(entry.name).setItems(new String[]{"编辑文本", "下载到手机"},(d,which)->{
            if(loading)return; loading=true; status.setText(which==0?"正在读取文件…":"正在下载…"); final int request=++generation;
            if(which==0) backend.read(entry.path,(file,error)->activity.runOnUiThread(()->{if(request!=generation || !dialog.isShowing())return;loading=false;if(error!=null || file==null){status.setText("读取失败："+(error==null?"无结果":error));return;}status.setText("");edit(entry.path,file);}));
            else backend.download(entry.path,(unused,error)->activity.runOnUiThread(()->{if(request!=generation || !dialog.isShowing())return;loading=false;status.setText(error==null?"文件已保存到手机":"下载失败："+error);}));
        }).setNegativeButton("取消",null).show();
    }
    private void edit(String filePath, FileText file) {
        EditText editor=new EditText(activity); editor.setText(file.text); editor.setGravity(Gravity.TOP); editor.setTextSize(14); editor.setSingleLine(false); editor.setInputType(android.text.InputType.TYPE_CLASS_TEXT|android.text.InputType.TYPE_TEXT_FLAG_MULTI_LINE|android.text.InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);
        AlertDialog editDialog=new AlertDialog.Builder(activity).setTitle(filePath).setView(editor).setNegativeButton("取消",null).setPositiveButton("保存",null).create();
        editDialog.setOnShowListener(d->editDialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(v->{
            String content=editor.getText().toString(); editDialog.getButton(AlertDialog.BUTTON_POSITIVE).setEnabled(false);
            backend.save(filePath,content,file.revision,(saved,error)->activity.runOnUiThread(()->{if(!editDialog.isShowing())return; editDialog.getButton(AlertDialog.BUTTON_POSITIVE).setEnabled(true); if(error!=null || saved==null){editor.setError(error==null?"保存失败":error);return;} editDialog.dismiss();status.setText("文件已保存");}));
        })); editDialog.show();
    }
}
