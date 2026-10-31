package com.cortex.mobile;
import android.content.SharedPreferences;
import java.lang.reflect.Proxy;
import java.util.*;
import org.json.*;

public final class SessionRenameTest {
 public static void main(String[] args)throws Exception {
  Map<String,String> values=new HashMap<>();
  SharedPreferences.Editor editor=(SharedPreferences.Editor)Proxy.newProxyInstance(SessionRenameTest.class.getClassLoader(),new Class[]{SharedPreferences.Editor.class},(proxy,method,a)->{if(method.getName().equals("putString")){values.put((String)a[0],(String)a[1]);return proxy;}if(method.getName().equals("commit"))return true;return null;});
  SharedPreferences prefs=(SharedPreferences)Proxy.newProxyInstance(SessionRenameTest.class.getClassLoader(),new Class[]{SharedPreferences.class},(proxy,method,a)->{if(method.getName().equals("getString"))return values.getOrDefault((String)a[0],(String)a[1]);if(method.getName().equals("edit"))return editor;return null;});
  SessionStore store=new SessionStore(null,prefs);String id=store.currentId();
  JSONArray messages=new JSONArray().put(new JSONObject().put("role","user").put("content","最初的问题"));store.save(id,messages);
  if(!store.list("").getJSONObject(0).getString("title").equals("最初的问题"))throw new AssertionError("automatic title");
  store.rename(id,"　 我的新名字  ");messages.put(new JSONObject().put("role","user").put("content","后续问题"));store.save(id,messages);
  SessionStore restored=new SessionStore(null,prefs);
  if(!restored.list("新名字").getJSONObject(0).getString("title").equals("我的新名字"))throw new AssertionError("renamed title or search");
  if(restored.load(id).length()!=2)throw new AssertionError("messages retained");
  for(String invalid:new String[]{" ","\n", "a\nb",new String(new char[101]).replace('\0','a')}){try{restored.rename(id,invalid);throw new AssertionError("invalid title accepted");}catch(IllegalArgumentException expected){}}
  try{restored.rename("missing","有效名称");throw new AssertionError("unknown session accepted");}catch(IllegalArgumentException expected){}
  if(!restored.list("新名字").getJSONObject(0).getString("title").equals("我的新名字"))throw new AssertionError("invalid rename changed title");
  System.out.println("Session rename persistence passed");
 }
}
