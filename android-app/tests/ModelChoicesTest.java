package com.cortex.mobile;
import android.content.SharedPreferences;
import java.lang.reflect.Proxy;
import java.util.*;
import org.json.*;

public final class ModelChoicesTest {
 public static void main(String[] args)throws Exception {
  JSONObject a=new JSONObject().put("id","profile-a").put("name","我的账号").put("model","gpt-5").put("provider","openai").put("catalog",new JSONArray().put("gpt-5").put("gpt-5-mini"));
  JSONObject b=new JSONObject().put("id","profile-b").put("name","另一个账号").put("model","gpt-5").put("provider","openai");
  JSONArray profiles=new JSONArray().put(a).put(b), choices=ModelChoices.local(profiles);
  if(choices.length()!=3||!choices.getJSONObject(1).getString("model").equals("gpt-5-mini"))throw new AssertionError("catalog versions");
  if(!ModelChoices.label(choices,0).contains("我的账号")||!ModelChoices.label(choices,2).contains("另一个账号"))throw new AssertionError("duplicate models");
  JSONArray large=new JSONArray();for(int i=0;i<500;i++)large.put("model-"+i);
  JSONArray many=ModelChoices.local(new JSONArray().put(new JSONObject().put("id","big").put("model","model-0").put("catalog",large)));
  if(many.length()!=500)throw new AssertionError("large catalog lost entries");
  for(int i=0;i<many.length();i++)if(many.getJSONObject(i).has("catalog"))throw new AssertionError("catalog duplicated per model");
  Map<String,String> saved=new HashMap<>();saved.put("model_profiles_v1",profiles.toString());saved.put("model_selected_v1","profile-b");saved.put("model_secret_profile-a","unchanged");
  SharedPreferences.Editor editor=(SharedPreferences.Editor)Proxy.newProxyInstance(ModelChoicesTest.class.getClassLoader(),new Class[]{SharedPreferences.Editor.class},(proxy,m,v)->{if(m.getName().equals("putString")){saved.put((String)v[0],(String)v[1]);return proxy;}return null;});
  SharedPreferences prefs=(SharedPreferences)Proxy.newProxyInstance(ModelChoicesTest.class.getClassLoader(),new Class[]{SharedPreferences.class},(proxy,m,v)->{switch(m.getName()){case "getString":return saved.getOrDefault((String)v[0],(String)v[1]);case "contains":return saved.containsKey((String)v[0]);case "edit":return editor;default:return null;}});
  ModelStore store=new ModelStore(null,prefs);store.selectProfileModel("profile-a","gpt-5-mini");
  if(!store.selectedModel().equals("gpt-5-mini")||!saved.get("model_selected_v1").equals("profile-a")||!saved.get("model_secret_profile-a").equals("unchanged"))throw new AssertionError("saved model and credentials");
  try{store.selectProfileModel("profile-a","not-in-catalog");throw new AssertionError("unlisted model accepted");}catch(Exception expected){}
  System.out.println("Model version selection passed");
 }
}
