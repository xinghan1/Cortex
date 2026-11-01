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
    private Group currentGroup;
    private int serial;
    ToolEventView(Context context,LinearLayout parent,boolean light,Map<String,Boolean> expanded) { this.context=context;this.parent=parent;this.light=light;this.expanded=expanded; }
    private int dp(int value){return (int)(value*context.getResources().getDisplayMetrics().density+.5f);}
    private TextView text(String value,int size,int color){TextView v=new TextView(context);v.setText(value);v.setTextSize(size);v.setTextColor(color);return v;}
    private String key(String id){return id==null||id.isEmpty()?"unknown-"+(++serial):id;}
    void breakGroup(){currentGroup=null;}
    private Group group(String id,String name){String category=ToolGrouping.category(name);if(currentGroup==null||!currentGroup.category.equals(category)||category.startsWith("tool:"))currentGroup=new Group(id,category,name);return currentGroup;}
    private String icon(String name){String category=ToolGrouping.category(name);if(category.equals("search"))return "⌕";if(name!=null&&(name.contains("command")||name.equals("bash")))return "▹";return "▤";}
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
        if(card==null){card=new Card(k,group(k,name));cards.put(k,card);}
        if(name!=null&&!name.isEmpty())card.name=name;
        if(input!=null && input!=JSONObject.NULL)card.input=pretty(input);
        card.update();
    }
    void finish(String id,String name,Object output,boolean error) {
        String k=key(id); Card card=cards.get(k);
        if(card==null){card=new Card(k,group(k,name));cards.put(k,card);}
        if(name!=null&&!name.isEmpty())card.name=name;
        card.output=pretty(output);card.done=true;card.error=error||failed(output);card.update();
    }
    void subagent(JSONObject agent) {
        breakGroup();
        String id="subagent:"+key(agent.optString("id")); int fg=light?0xff20242c:0xffedf0f5, muted=light?0xff69717d:0xffa1a8b4;
        LinearLayout box=new LinearLayout(context);box.setOrientation(LinearLayout.VERTICAL);box.setPadding(dp(12),dp(5),dp(12),dp(7));
        GradientDrawable background=new GradientDrawable();background.setColor(light?0xfff0f1f3:0xff1b1e24);background.setCornerRadius(dp(12));box.setBackground(background);
        LinearLayout.LayoutParams params=new LinearLayout.LayoutParams(-1,-2);params.bottomMargin=dp(8);parent.addView(box,params);
        TextView header=text("",14,fg);header.setTypeface(null,Typeface.BOLD);header.setPadding(0,dp(8),0,dp(8));box.addView(header);
        LinearLayout detail=new LinearLayout(context);detail.setOrientation(LinearLayout.VERTICAL);detail.setVisibility(Boolean.TRUE.equals(expanded.get(id))?View.VISIBLE:View.GONE);box.addView(detail);
        String[] fields={"task"}, labels={"任务"};
        for(int i=0;i<fields.length;i++){Object value=agent.opt(fields[i]);if(value==null||value==JSONObject.NULL||String.valueOf(value).isEmpty())continue;TextView label=text(labels[i],12,muted);label.setPadding(0,dp(7),0,dp(4));detail.addView(label);TextView body=text(pretty(value),13,fg);body.setTextIsSelectable(true);detail.addView(body);}
        Object activity=agent.opt("activity");java.util.ArrayList<SubagentActivity.Entry> entries=SubagentActivity.parse(activity);
        if(entries==null){if(activity!=null&&activity!=JSONObject.NULL&&!String.valueOf(activity).isEmpty()){TextView label=text("操作过程",12,muted);detail.addView(label);TextView fallback=text(pretty(activity),13,fg);fallback.setTextIsSelectable(true);detail.addView(fallback);}}
        else if(!entries.isEmpty()){
            TextView label=text("操作过程",12,muted);label.setPadding(0,dp(7),0,dp(4));detail.addView(label);int index=0;
            for(int cursor=0;cursor<entries.size();){
                SubagentActivity.Entry entry=entries.get(cursor);
                if(!"tool".equals(entry.type)){TextView body=text(entry.text,13,fg);body.setTextIsSelectable(true);body.setPadding(0,dp(5),0,dp(5));detail.addView(body);cursor++;continue;}
                if(!SubagentActivity.groupable(entry)){subagentToolRow(detail,entry,id,index++,"running".equals(agent.optString("status")),fg,muted);cursor++;continue;}
                java.util.ArrayList<SubagentActivity.Entry> grouped=new java.util.ArrayList<>();int first=cursor;
                while(cursor<entries.size()&&SubagentActivity.groupable(entries.get(cursor)))grouped.add(entries.get(cursor++));
                String groupKey=id+":operations:"+(entry.id.isEmpty()?String.valueOf(first):entry.id);
                LinearLayout group=new LinearLayout(context);group.setOrientation(LinearLayout.VERTICAL);group.setPadding(dp(10),dp(2),dp(10),dp(2));
                GradientDrawable border=new GradientDrawable();border.setColor(Color.TRANSPARENT);border.setCornerRadius(dp(10));border.setStroke(dp(1),light?0xffc9cdd4:0xff373d47);group.setBackground(border);
                LinearLayout.LayoutParams gp=new LinearLayout.LayoutParams(-1,-2);gp.bottomMargin=dp(6);detail.addView(group,gp);
                TextView groupHead=text("",13,fg);groupHead.setPadding(0,dp(9),0,dp(9));group.addView(groupHead);
                LinearLayout groupBody=new LinearLayout(context);groupBody.setOrientation(LinearLayout.VERTICAL);groupBody.setVisibility(Boolean.TRUE.equals(expanded.get(groupKey))?View.VISIBLE:View.GONE);group.addView(groupBody);
                for(SubagentActivity.Entry member:grouped)subagentToolRow(groupBody,member,id,index++,"running".equals(agent.optString("status")),fg,muted);
                String caption=SubagentActivity.groupCaption(grouped,"running".equals(agent.optString("status")));Runnable update=()->groupHead.setText((groupBody.getVisibility()==View.VISIBLE?"▾  ":"▸  ")+"▣  "+caption+"  "+grouped.size()+" 项");update.run();
                groupHead.setOnClickListener(v->{boolean open=groupBody.getVisibility()!=View.VISIBLE;groupBody.setVisibility(open?View.VISIBLE:View.GONE);expanded.put(groupKey,open);update.run();});
            }
        }
        Object summary=agent.opt("summary");if(summary!=null&&summary!=JSONObject.NULL&&!String.valueOf(summary).isEmpty()){TextView label=text("总结",12,muted);label.setPadding(0,dp(10),0,dp(4));detail.addView(label);TextView body=text(pretty(summary),13,fg);body.setTextIsSelectable(true);detail.addView(body);}
        String name=agent.optString("name","子任务"), status=ToolNames.status(agent.optString("status",""));
        Runnable title=()->header.setText("✿  "+name+(status.isEmpty()?"":"  "+status)+(detail.getVisibility()==View.VISIBLE?"  ⌄":"  ›"));title.run();
        header.setOnClickListener(v->{boolean open=detail.getVisibility()!=View.VISIBLE;detail.setVisibility(open?View.VISIBLE:View.GONE);expanded.put(id,open);title.run();});
    }
    private void subagentToolRow(LinearLayout parent,SubagentActivity.Entry entry,String id,int index,boolean running,int fg,int muted){
        String itemKey=id+":tool:"+(entry.id.isEmpty()?String.valueOf(index):entry.id);
        LinearLayout row=new LinearLayout(context);row.setOrientation(LinearLayout.VERTICAL);parent.addView(row);
        TextView summary=text("",13,fg);summary.setPadding(0,dp(8),0,dp(8));row.addView(summary);
        LinearLayout data=new LinearLayout(context);data.setOrientation(LinearLayout.VERTICAL);data.setVisibility(Boolean.TRUE.equals(expanded.get(itemKey))?View.VISIBLE:View.GONE);row.addView(data);
        if(entry.args!=null&&entry.args!=JSONObject.NULL){data.addView(text("输入参数",12,muted));TextView value=text("",13,fg);value.setTextIsSelectable(true);code(value,pretty(entry.args));data.addView(value);}
        if(entry.result!=null&&entry.result!=JSONObject.NULL){data.addView(text("执行结果",12,muted));TextView value=text("",13,fg);value.setTextIsSelectable(true);code(value,pretty(entry.result));data.addView(value);}
        String caption=SubagentActivity.caption(entry,running);Runnable update=()->summary.setText((data.getVisibility()==View.VISIBLE?"▾  ":"▸  ")+caption);update.run();
        summary.setOnClickListener(v->{boolean open=data.getVisibility()!=View.VISIBLE;data.setVisibility(open?View.VISIBLE:View.GONE);expanded.put(itemKey,open);update.run();});
    }
    private final class Group {
        final String id,category,fallback; final LinearLayout box,detail; final TextView header; final java.util.List<Card> members=new java.util.ArrayList<>();
        Group(String firstId,String category,String name){
            this.id="group:"+firstId;this.category=category;this.fallback=ToolNames.caption(name,false,false,"").replaceFirst("^正在", "");
            int fg=light?0xff20242c:0xffedf0f5;
            box=new LinearLayout(context);box.setOrientation(LinearLayout.VERTICAL);
            LinearLayout.LayoutParams params=new LinearLayout.LayoutParams(-1,-2);params.bottomMargin=dp(2);parent.addView(box,params);
            header=text("",14,fg);header.setPadding(dp(4),dp(10),dp(4),dp(10));box.addView(header);
            detail=new LinearLayout(context);detail.setOrientation(LinearLayout.VERTICAL);detail.setVisibility(Boolean.TRUE.equals(expanded.get(id))?View.VISIBLE:View.GONE);box.addView(detail);
            header.setOnClickListener(v->{boolean open=detail.getVisibility()!=View.VISIBLE;detail.setVisibility(open?View.VISIBLE:View.GONE);expanded.put(id,open);update();});
        }
        void update(){int waiting=0,failed=0;java.util.List<String> names=new java.util.ArrayList<>();for(Card c:members){names.add(c.name);if(!c.done)waiting++;if(c.error)failed++;}
            boolean single=members.size()==1;header.setVisibility(single?View.GONE:View.VISIBLE);
            detail.setVisibility(single||Boolean.TRUE.equals(expanded.get(id))?View.VISIBLE:View.GONE);
            boolean hasCommand=false;for(String name:names)if(name.contains("command")||name.equals("bash"))hasCommand=true;
            String symbol=category.equals("search")?"⌕":hasCommand?"▹":"▤";
            header.setText(symbol+"  "+ToolGrouping.label(category,names,waiting,failed,fallback)+(detail.getVisibility()==View.VISIBLE?"  ⌄":"  ›"));header.setTextColor(failed>0?(light?0xffb42318:0xffff8e83):(light?0xff69717d:0xffa1a8b4));}
    }
    private final class Card {
        final String id; final Group group; final LinearLayout box,detail; final TextView header,inputText,resultText; String name="工具",input="",output=""; boolean done,error;
        Card(String id,Group group){
            this.id=id;this.group=group;if(group.members.size()==1&&Boolean.TRUE.equals(expanded.get(group.members.get(0).id)))expanded.put(group.id,true);group.members.add(this); int fg=light?0xff20242c:0xffedf0f5, muted=light?0xff69717d:0xffa1a8b4;
            box=new LinearLayout(context);box.setOrientation(LinearLayout.VERTICAL);box.setPadding(dp(4),0,dp(4),0);
            LinearLayout.LayoutParams boxParams=new LinearLayout.LayoutParams(-1,-2);group.detail.addView(box,boxParams);
            header=text("",14,fg);header.setGravity(Gravity.CENTER_VERTICAL);header.setPadding(0,dp(10),0,dp(10));box.addView(header);
            detail=new LinearLayout(context);detail.setOrientation(LinearLayout.VERTICAL);box.addView(detail);detail.setVisibility(Boolean.TRUE.equals(expanded.get(id))?View.VISIBLE:View.GONE);
            TextView inputLabel=text("输入参数",12,muted);inputLabel.setPadding(0,dp(5),0,dp(4));detail.addView(inputLabel);
            inputText=text("",13,fg);inputText.setTypeface(Typeface.MONOSPACE);inputText.setTextIsSelectable(true);detail.addView(inputText);
            TextView resultLabel=text("返回结果",12,muted);resultLabel.setPadding(0,dp(10),0,dp(4));detail.addView(resultLabel);
            resultText=text("",13,fg);resultText.setTypeface(Typeface.MONOSPACE);resultText.setTextIsSelectable(true);detail.addView(resultText);
            header.setOnClickListener(v->{boolean open=detail.getVisibility()!=View.VISIBLE;detail.setVisibility(open?View.VISIBLE:View.GONE);expanded.put(id,open);update();});
        }
        void update(){header.setText(icon(name)+"  "+ToolNames.caption(name,done,error,location(input))+(detail.getVisibility()==View.VISIBLE?"  ⌄":""));code(inputText,input.isEmpty()?"—":input);code(resultText,done?(output.isEmpty()?"—":output):"等待返回…");resultText.setTextColor(error?(light?0xffb42318:0xffff8e83):(light?0xff20242c:0xffedf0f5));group.update();}
    }
}
