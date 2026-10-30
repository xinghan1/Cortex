package com.cortex.mobile;

import android.app.Activity;
import android.app.Dialog;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.view.Gravity;
import android.view.Window;
import android.view.WindowManager;
import android.widget.*;
import org.json.JSONArray;
import org.json.JSONObject;

/** Model picker; unsupported reasoning options are never presented as functional. */
final class ModelSheet {
    interface Done { void apply(String model, String effort); }
    static String effort(Activity activity, JSONObject profile) {
        if (profile == null || !("deepseek-account".equals(profile.optString("authMode")) || supportsOpenAiEffort(profile))) return "default";
        String value=activity.getSharedPreferences("cortex",0).getString("effort_"+profile.optString("id"),"default");
        return value.matches("default|low|medium|high") || "max".equals(value) && "deepseek-account".equals(profile.optString("authMode")) ? value : "default";
    }
    private static boolean supportsOpenAiEffort(JSONObject profile) { String id=profile.optString("model","").toLowerCase(java.util.Locale.ROOT); return "openai".equals(profile.optString("provider")) && id.startsWith("gpt-5") && !id.contains("pro"); }
    static void show(Activity activity, ModelStore store, boolean remote, JSONObject remoteData, Done done) {
        boolean light=activity.getSharedPreferences("cortex",0).getBoolean("light_theme",false);
        int bg=light?0xfff4f4f5:0xff252628, fg=light?0xff191a1e:0xfff1f2f4, muted=light?0xff71747b:0xffaaaeb6;
        float d=activity.getResources().getDisplayMetrics().density;
        Dialog dialog=new Dialog(activity); LinearLayout box=new LinearLayout(activity);box.setOrientation(LinearLayout.VERTICAL);box.setPadding((int)(20*d),(int)(24*d),(int)(20*d),(int)(20*d));
        GradientDrawable shape=new GradientDrawable();shape.setColor(bg);shape.setCornerRadii(new float[]{24*d,24*d,24*d,24*d,0,0,0,0});box.setBackground(shape);
        TextView title=new TextView(activity);title.setText("模型");title.setTextSize(20);title.setTextColor(fg);box.addView(title);
        JSONArray models=remote ? remoteData.optJSONArray("models") : store.allProfiles(); if(models==null) models=new JSONArray();
        String[] names=new String[models.length()+1]; names[0]="选择模型";
        int initial=0;String selected=remote?remoteData.optString("model",""):(store.selectedProfile()==null?"":store.selectedProfile().optString("id"));
        for(int i=0;i<models.length();i++){JSONObject p=models.optJSONObject(i);names[i+1]=p==null?"":p.optString("name",p.optString("id"));if(p!=null && selected.equals(p.optString("id")))initial=i+1;}
        Spinner model=new Spinner(activity);ArrayAdapter<String> ma=new ArrayAdapter<>(activity,android.R.layout.simple_spinner_item,names);ma.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item);model.setAdapter(ma);model.setSelection(initial);box.addView(model,new LinearLayout.LayoutParams(-1,(int)(55*d)));
        TextView label=new TextView(activity);label.setText("思考强度");label.setTextColor(fg);label.setTextSize(16);label.setPadding(0,(int)(10*d),0,0);box.addView(label);
        Spinner strength=new Spinner(activity);box.addView(strength,new LinearLayout.LayoutParams(-1,(int)(55*d)));
        TextView hint=new TextView(activity);hint.setTextColor(muted);hint.setTextSize(12);box.addView(hint);
        final JSONArray entries=models;
        model.setOnItemSelectedListener(new android.widget.AdapterView.OnItemSelectedListener(){public void onNothingSelected(android.widget.AdapterView<?> p){} public void onItemSelected(android.widget.AdapterView<?> parent,android.view.View v,int position,long id){
            JSONObject profile=position>0?entries.optJSONObject(position-1):null;java.util.ArrayList<String> values=new java.util.ArrayList<>();values.add("default");
            if(remote && profile!=null && selected.equals(profile.optString("id"))){JSONArray allowed=remoteData.optJSONArray("reasoningEfforts");if(allowed!=null)for(int i=0;i<allowed.length();i++){String e=allowed.optString(i);if(e.matches("none|enabled|minimal|low|medium|high|xhigh|max|ultra")&&!values.contains(e))values.add(e);}}
            else if(!remote && profile!=null && "deepseek-account".equals(profile.optString("authMode"))){values.add("low");values.add("high");values.add("max");}
            else if(!remote && profile!=null && supportsOpenAiEffort(profile)){values.add("low");values.add("medium");values.add("high");}
            String[] labels=new String[values.size()];for(int i=0;i<values.size();i++)labels[i]=name(values.get(i));ArrayAdapter<String> a=new ArrayAdapter<>(activity,android.R.layout.simple_spinner_item,labels);a.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item);strength.setAdapter(a);strength.setTag(values);
            String current=remote ? remoteData.optString("reasoningEffort","default") : effort(activity,profile);int index=values.indexOf(current);strength.setSelection(Math.max(0,index));hint.setText(values.size()==1?"该模型暂未提供可调整的思考强度":"选择模型支持的思考强度");
        }});
        TextView settings=new TextView(activity);settings.setText("模型设置  ›");settings.setTextColor(fg);settings.setTextSize(16);settings.setGravity(Gravity.CENTER_VERTICAL);box.addView(settings,new LinearLayout.LayoutParams(-1,(int)(55*d)));settings.setOnClickListener(v->{dialog.dismiss();store.showManager(()->{});});
        Button finish=new Button(activity);finish.setText("完成");finish.setAllCaps(false);box.addView(finish,new LinearLayout.LayoutParams(-1,(int)(50*d)));finish.setOnClickListener(v->{int pos=model.getSelectedItemPosition();if(pos<1){Toast.makeText(activity,"请选择模型",Toast.LENGTH_SHORT).show();return;}JSONObject profile=entries.optJSONObject(pos-1);if(profile==null)return;if(remote && !profile.optBoolean("supportsTools",true)){Toast.makeText(activity,"此模型不支持工具调用",Toast.LENGTH_SHORT).show();return;}@SuppressWarnings("unchecked") java.util.ArrayList<String> values=(java.util.ArrayList<String>)strength.getTag();String e=values==null?"default":values.get(strength.getSelectedItemPosition());String id=profile.optString("id");if(!remote){store.selectProfile(id);activity.getSharedPreferences("cortex",0).edit().putString("effort_"+id,e).apply();}dialog.dismiss();done.apply(id,e);});
        box.setOnApplyWindowInsetsListener((v,insets)->{int bottom=android.os.Build.VERSION.SDK_INT>=30?insets.getInsets(android.view.WindowInsets.Type.systemBars() | android.view.WindowInsets.Type.displayCutout()).bottom:insets.getSystemWindowInsetBottom();v.setPadding((int)(20*d),(int)(24*d),(int)(20*d),(int)(20*d)+bottom);return insets;});
        dialog.setContentView(box);Window w=dialog.getWindow();if(w!=null){w.setBackgroundDrawableResource(android.R.color.transparent);w.setGravity(Gravity.BOTTOM);w.setLayout(WindowManager.LayoutParams.MATCH_PARENT,WindowManager.LayoutParams.WRAP_CONTENT);w.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);}dialog.show();if(w!=null)w.setLayout(WindowManager.LayoutParams.MATCH_PARENT,WindowManager.LayoutParams.WRAP_CONTENT);box.requestApplyInsets();
    }
    private static String name(String s){switch(s){case "none":return "关闭";case "enabled":return "开启";case "minimal":return "最低";case "low":return "低";case "medium":return "中";case "high":return "高";case "xhigh":return "极高";case "max":return "最高";case "ultra":return "超高";default:return "默认";}}
}
