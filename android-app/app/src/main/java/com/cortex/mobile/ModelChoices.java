package com.cortex.mobile;

import org.json.JSONArray;
import org.json.JSONObject;
import java.util.LinkedHashSet;

/** Entries keep the connection profile alongside each model, including duplicate model IDs. */
final class ModelChoices {
    private ModelChoices() {}
    static JSONArray local(JSONArray profiles) {
        JSONArray result=new JSONArray();
        for(int i=0;i<profiles.length();i++) {
            JSONObject p=profiles.optJSONObject(i);if(p==null||p.optString("id").isEmpty())continue;
            LinkedHashSet<String> ids=new LinkedHashSet<>();String current=p.optString("model","");if(!current.isEmpty())ids.add(current);
            JSONArray catalog=p.optJSONArray("catalog");if(catalog!=null)for(int j=0;j<catalog.length();j++){String model=catalog.optString(j,"");if(!model.trim().isEmpty()&&model.length()<=200)ids.add(model);}
            for(String model:ids)try { JSONObject copy=new JSONObject();for(String key:new String[]{"id","name","provider","authMode"})if(p.has(key))copy.put(key,p.opt(key));copy.put("model",model);result.put(copy); }catch(Exception ignored){}
        }
        return result;
    }
    static String label(JSONArray entries,int index) {
        JSONObject row=entries.optJSONObject(index);if(row==null)return "";String model=row.optString("model");int matches=0;
        for(int i=0;i<entries.length();i++){JSONObject other=entries.optJSONObject(i);if(other!=null&&model.equals(other.optString("model")))matches++;}
        if(matches<=1)return model;
        String name=row.optString("name",row.optString("provider"));int sameName=0;
        for(int i=0;i<entries.length();i++){JSONObject other=entries.optJSONObject(i);if(other!=null&&model.equals(other.optString("model"))&&name.equals(other.optString("name",other.optString("provider"))))sameName++;}
        String id=row.optString("id");return model+" · "+name+(sameName>1?" ("+id.substring(0,Math.min(8,id.length()))+")":"");
    }
}
