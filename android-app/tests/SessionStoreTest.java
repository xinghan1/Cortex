package com.cortex.mobile;
import android.content.SharedPreferences;
import java.lang.reflect.Proxy;
import java.util.*;
import org.json.JSONArray;
import org.json.JSONObject;

public final class SessionStoreTest {
 public static void main(String[] args) {
  Map<String,String> values=new HashMap<>();
  SharedPreferences.Editor editor=(SharedPreferences.Editor)Proxy.newProxyInstance(SessionStoreTest.class.getClassLoader(),new Class[]{SharedPreferences.Editor.class},(proxy,method,a)->{if(method.getName().equals("putString")){values.put((String)a[0],(String)a[1]);return proxy;}if(method.getName().equals("commit"))return true;return null;});
  SharedPreferences prefs=(SharedPreferences)Proxy.newProxyInstance(SessionStoreTest.class.getClassLoader(),new Class[]{SharedPreferences.class},(proxy,method,a)->{if(method.getName().equals("getString"))return values.getOrDefault((String)a[0],(String)a[1]);if(method.getName().equals("edit"))return editor;return null;});
  SessionStore store=new SessionStore(null,prefs);String first=store.currentId(),second=store.create(),third=store.create();
  store.setPinned(Collections.singleton(first),true);JSONArray rows=store.list("");if(!rows.optJSONObject(0).optString("id").equals(first)||!rows.optJSONObject(0).optBoolean("pinned"))throw new AssertionError("pinned ordering");
  SessionStore restored=new SessionStore(null,prefs);if(!restored.list("").optJSONObject(0).optString("id").equals(first))throw new AssertionError("pinned persistence");
  restored.setPinned(Collections.singleton(first),false);if(restored.list("").optJSONObject(0).optBoolean("pinned"))throw new AssertionError("unpin");
  try { JSONArray history=new JSONArray();for(int i=0;i<300;i++)history.put(new JSONObject().put("role",i%2==0?"user":"assistant").put("content","第"+i+"条 "+"内容".repeat(200)));restored.save(first,history);SessionStore reload=new SessionStore(null,prefs);JSONArray saved=reload.load(first);if(saved.length()!=history.length()||!saved.getJSONObject(0).getString("content").equals(history.getJSONObject(0).getString("content"))||!saved.getJSONObject(299).getString("content").equals(history.getJSONObject(299).getString("content")))throw new AssertionError("会话历史不可自动省略"); } catch(Exception e){throw new AssertionError(e);}
  restored.deleteMany(Arrays.asList(second,third));if(!restored.currentId().equals(first)||restored.list("").length()!=1)throw new AssertionError("bulk delete/current");
  restored.deleteMany(Collections.singleton(first));if(restored.list("").length()!=1||restored.currentId().equals(first))throw new AssertionError("empty recovery");
  System.out.println("Session store pin and bulk delete passed");
 }
}
