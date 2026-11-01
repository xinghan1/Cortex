package com.cortex.mobile;

import org.json.JSONArray;
import org.json.JSONObject;
import org.json.JSONTokener;
import java.util.ArrayList;
import java.util.HashMap;

/** Presentation projection for redacted child activity; older snapshots may lack status or either event. */
final class SubagentActivity {
    static final class Entry { String type, name="", id="", status="", text=""; Object args, result; }
    static ArrayList<Entry> parse(Object value) {
        JSONArray items;
        try { Object data=value instanceof String?new JSONTokener((String)value).nextValue():value; if(!(data instanceof JSONArray))return null;items=(JSONArray)data; }
        catch(Exception ignored){return null;}
        ArrayList<Entry> rows=new ArrayList<>();HashMap<String,Entry> pending=new HashMap<>();
        for(int i=0;i<items.length();i++){
            JSONObject item=items.optJSONObject(i);if(item==null)continue;
            String type=item.optString("type"),id=item.optString("toolCallId"),name=item.optString("name");
            if("tool-start".equals(type)){
                Entry e=new Entry();e.type="tool";e.id=id;e.name=name;e.args=item.opt("args");rows.add(e);if(!id.isEmpty())pending.put(id,e);
            } else if("tool-result".equals(type)){
                Entry e=id.isEmpty()?null:pending.remove(id);
                if(e==null){e=new Entry();e.type="tool";e.id=id;e.name=name;rows.add(e);}else if(e.name.isEmpty())e.name=name;
                e.result=item.opt("result");e.status=item.optString("status","unknown");
            } else {
                String text=item.optString("text","");if(text.isEmpty())continue;Entry e=new Entry();e.type=type;e.text=text;rows.add(e);
            }
        }
        return rows;
    }
    static String caption(Entry e,boolean running){
        String location="";if(e.args instanceof JSONObject){JSONObject obj=(JSONObject)e.args;location=obj.optString("path",obj.optString("query",""));}
        if(e.status.isEmpty())return running?ToolNames.caption(e.name,false,false,location):ToolNames.caption(e.name,false,false,location).replaceFirst("^正在","")+" · 未返回";
        if("completed".equals(e.status))return ToolNames.caption(e.name,true,false,location);
        if("failed".equals(e.status))return ToolNames.caption(e.name,true,true,location);
        String label=ToolNames.caption(e.name,false,false,location).replaceFirst("^正在","");
        return label+("denied".equals(e.status)?" · 未执行":"stopped".equals(e.status)?" · 已停止":" · 已返回");
    }
    private SubagentActivity(){}
}
