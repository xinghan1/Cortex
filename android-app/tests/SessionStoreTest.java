package com.cortex.mobile;
import android.content.SharedPreferences;
import java.lang.reflect.Proxy;
import java.util.*;
import org.json.JSONArray;

public final class SessionStoreTest {
 public static void main(String[] args) {
  Map<String,String> values=new HashMap<>();
  SharedPreferences.Editor editor=(SharedPreferences.Editor)Proxy.newProxyInstance(SessionStoreTest.class.getClassLoader(),new Class[]{SharedPreferences.Editor.class},(proxy,method,a)->{if(method.getName().equals("putString")){values.put((String)a[0],(String)a[1]);return proxy;}if(method.getName().equals("commit"))return true;return null;});
  SharedPreferences prefs=(SharedPreferences)Proxy.newProxyInstance(SessionStoreTest.class.getClassLoader(),new Class[]{SharedPreferences.class},(proxy,method,a)->{if(method.getName().equals("getString"))return values.getOrDefault((String)a[0],(String)a[1]);if(method.getName().equals("edit"))return editor;return null;});
  SessionStore store=new SessionStore(null,prefs);String first=store.currentId(),second=store.create(),third=store.create();
  store.setPinned(Collections.singleton(first),true);JSONArray rows=store.list("");if(!rows.optJSONObject(0).optString("id").equals(first)||!rows.optJSONObject(0).optBoolean("pinned"))throw new AssertionError("pinned ordering");
  SessionStore restored=new SessionStore(null,prefs);if(!restored.list("").optJSONObject(0).optString("id").equals(first))throw new AssertionError("pinned persistence");
  restored.setPinned(Collections.singleton(first),false);if(restored.list("").optJSONObject(0).optBoolean("pinned"))throw new AssertionError("unpin");
  restored.deleteMany(Arrays.asList(second,third));if(!restored.currentId().equals(first)||restored.list("").length()!=1)throw new AssertionError("bulk delete/current");
  restored.deleteMany(Collections.singleton(first));if(restored.list("").length()!=1||restored.currentId().equals(first))throw new AssertionError("empty recovery");
  System.out.println("Session store pin and bulk delete passed");
 }
}
