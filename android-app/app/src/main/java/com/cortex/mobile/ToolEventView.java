package com.cortex.mobile;

import android.content.Context;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.view.Gravity;
import android.view.View;
import android.widget.LinearLayout;
import android.widget.TextView;
import org.json.JSONArray;
import org.json.JSONObject;
import org.json.JSONTokener;
import java.util.HashMap;
import java.util.Map;

/** Collapsible native tool cards, keyed by tool-call ID for start/result pairing. */
final class ToolEventView {
    private final Context context; private final LinearLayout parent; private final boolean light;
    private final Map<String,Card> cards=new HashMap<>(); private final Map<String,Boolean> expanded;
    private int serial;
    ToolEventView(Context context,LinearLayout parent,boolean light,Map<String,Boolean> expanded) { this.context=context;this.parent=parent;this.light=light;this.expanded=expanded; }
    private int dp(int value){return (int)(value*context.getResources().getDisplayMetrics().density+.5f);}
    private TextView text(String value,int size,int color){TextView v=new TextView(context);v.setText(value);v.setTextSize(size);v.setTextColor(color);return v;}
    private String key(String id){return id==null||id.isEmpty()?"unknown-"+(++serial):id;}
    private String pretty(Object value){
        if(value==null||value==JSONObject.NULL)return "";
        String original=String.valueOf(value);if(!JsonValidity.isContainer(original))return original;
        try { Object parsed=value instanceof String?new JSONTokener((String)value).nextValue():value; if(parsed instanceof JSONObject)return ((JSONObject)parsed).toString(2); if(parsed instanceof JSONArray)return ((JSONArray)parsed).toString(2); }
        catch(Exception ignored) { }
        return original;
    }
    private void code(TextView target,String value){if(JsonValidity.isContainer(value))MarkdownRenderer.applyJsonCode(target,value,light);else target.setText(value);}
    private String location(String input){
        if(!JsonValidity.isContainer(input))return "";
        try { Object parsed=new JSONTokener(input).nextValue();if(parsed instanceof JSONObject){JSONObject obj=(JSONObject)parsed;for(String key:new String[]{"path","file_path","url"}){Object v=obj.opt(key);if(v instanceof String&&!((String)v).isEmpty())return (String)v;}} }catch(Exception ignored) { }
        return "";
    }
    private boolean failed(Object value) {
        try { Object parsed=value instanceof String?new JSONTokener((String)value).nextValue():value; if(parsed instanceof JSONObject) { JSONObject obj=(JSONObject)parsed; String status=obj.optString("status",""); return obj.optBoolean("isError",false) || obj.optBoolean("error",false) || (obj.has("error") && !obj.isNull("error") && !"false".equals(obj.optString("error"))) || (obj.has("success") && !obj.optBoolean("success",true)) || (obj.has("ok") && !obj.optBoolean("ok",true)) || status.equals("error") || status.equals("failed"); } }
        catch(Exception ignored) { }
        return false;
    }
    void start(String id,String name,Object input) {
        String k=key(id); Card card=cards.get(k);
        if(card==null){card=new Card(k);cards.put(k,card);}
        if(name!=null&&!name.isEmpty())card.name=name;
        if(input!=null && input!=JSONObject.NULL)card.input=pretty(input);
        card.update();
    }
    void finish(String id,String name,Object output,boolean error) {
        String k=key(id); Card card=cards.get(k);
        if(card==null){card=new Card(k);cards.put(k,card);}
        if(name!=null&&!name.isEmpty())card.name=name;
        card.output=pretty(output);card.done=true;card.error=error||failed(output);card.update();
    }
    void subagent(JSONObject agent) {
        String id="subagent:"+key(agent.optString("id")); int fg=light?0xff20242c:0xffedf0f5, muted=light?0xff69717d:0xffa1a8b4;
        LinearLayout box=new LinearLayout(context);box.setOrientation(LinearLayout.VERTICAL);box.setPadding(dp(12),dp(5),dp(12),dp(7));
        GradientDrawable background=new GradientDrawable();background.setColor(light?0xfff0f1f3:0xff1b1e24);background.setCornerRadius(dp(12));box.setBackground(background);
        LinearLayout.LayoutParams params=new LinearLayout.LayoutParams(-1,-2);params.bottomMargin=dp(8);parent.addView(box,params);
        TextView header=text("",14,fg);header.setTypeface(null,Typeface.BOLD);header.setPadding(0,dp(8),0,dp(8));box.addView(header);
        LinearLayout detail=new LinearLayout(context);detail.setOrientation(LinearLayout.VERTICAL);detail.setVisibility(Boolean.TRUE.equals(expanded.get(id))?View.VISIBLE:View.GONE);box.addView(detail);
        String[] fields={"task","summary","activity"}, labels={"任务","总结","操作过程"};
        for(int i=0;i<fields.length;i++){Object value=agent.opt(fields[i]);if(value==null||value==JSONObject.NULL||String.valueOf(value).isEmpty())continue;TextView label=text(labels[i],12,muted);label.setPadding(0,dp(7),0,dp(4));detail.addView(label);TextView body=text(pretty(value),13,fg);body.setTextIsSelectable(true);detail.addView(body);}
        String name=agent.optString("name","子任务"), status=ToolNames.status(agent.optString("status",""));
        Runnable title=()->header.setText((detail.getVisibility()==View.VISIBLE?"▾  ":"▸  ")+name+(status.isEmpty()?"":"  ·  "+status));title.run();
        header.setOnClickListener(v->{boolean open=detail.getVisibility()!=View.VISIBLE;detail.setVisibility(open?View.VISIBLE:View.GONE);expanded.put(id,open);title.run();});
    }
    private final class Card {
        final String id; final LinearLayout box,detail; final TextView header,inputText,resultText; String name="工具",input="",output=""; boolean done,error;
        Card(String id){
            this.id=id; int fg=light?0xff20242c:0xffedf0f5, muted=light?0xff69717d:0xffa1a8b4;
            box=new LinearLayout(context);box.setOrientation(LinearLayout.VERTICAL);box.setPadding(dp(12),dp(5),dp(12),dp(7));
            GradientDrawable background=new GradientDrawable();background.setColor(light?0xfff0f1f3:0xff1b1e24);background.setCornerRadius(dp(12));box.setBackground(background);
            LinearLayout.LayoutParams boxParams=new LinearLayout.LayoutParams(-1,-2);boxParams.bottomMargin=dp(8);parent.addView(box,boxParams);
            header=text("",14,fg);header.setTypeface(null,Typeface.BOLD);header.setGravity(Gravity.CENTER_VERTICAL);header.setPadding(0,dp(8),0,dp(8));box.addView(header);
            detail=new LinearLayout(context);detail.setOrientation(LinearLayout.VERTICAL);box.addView(detail);detail.setVisibility(Boolean.TRUE.equals(expanded.get(id))?View.VISIBLE:View.GONE);
            TextView inputLabel=text("输入参数",12,muted);inputLabel.setPadding(0,dp(5),0,dp(4));detail.addView(inputLabel);
            inputText=text("",13,fg);inputText.setTypeface(Typeface.MONOSPACE);inputText.setTextIsSelectable(true);detail.addView(inputText);
            TextView resultLabel=text("返回结果",12,muted);resultLabel.setPadding(0,dp(10),0,dp(4));detail.addView(resultLabel);
            resultText=text("",13,fg);resultText.setTypeface(Typeface.MONOSPACE);resultText.setTextIsSelectable(true);detail.addView(resultText);
            header.setOnClickListener(v->{boolean open=detail.getVisibility()!=View.VISIBLE;detail.setVisibility(open?View.VISIBLE:View.GONE);expanded.put(id,open);update();});
        }
        void update(){header.setText((detail.getVisibility()==View.VISIBLE?"▾  ":"▸  ")+ToolNames.caption(name,done,error,location(input)));code(inputText,input.isEmpty()?"—":input);code(resultText,done?(output.isEmpty()?"—":output):"等待返回…");resultText.setTextColor(error?(light?0xffb42318:0xffff8e83):(light?0xff20242c:0xffedf0f5));}
    }
}
