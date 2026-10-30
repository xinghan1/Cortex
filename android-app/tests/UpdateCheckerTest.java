package com.cortex.mobile;

import org.json.JSONArray;
import org.json.JSONObject;

public final class UpdateCheckerTest {
    private static JSONObject asset(String name,String host){return new JSONObject().put("name",name).put("browser_download_url",host+"/xinghan1/Cortex/releases/download/v0.10.0/"+name);}
    public static void main(String[] args) throws Exception {
        JSONObject desktop=new JSONObject().put("assets",new JSONArray().put(asset("Cortex-Setup-0.24.0-x64.exe","https://github.com")));
        if(UpdateChecker.parse(desktop,"0.3.0").url!=null || !UpdateChecker.parse(desktop,"0.3.0").message.contains("未包含"))throw new AssertionError("desktop-only release was mistaken for Android");
        String name="Cortex-Android-0.10.0.apk";
        JSONObject untrusted=new JSONObject().put("assets",new JSONArray().put(asset(name,"https://evil.example")));
        if(UpdateChecker.parse(untrusted,"0.3.0").url!=null)throw new AssertionError("untrusted host accepted");
        JSONObject valid=new JSONObject().put("assets",new JSONArray().put(asset(name,"https://github.com")));
        if(UpdateChecker.parse(valid,"0.3.0").url==null)throw new AssertionError("newer version not offered");
        if(UpdateChecker.parse(valid,"0.10.0").url!=null || UpdateChecker.parse(valid,"0.11.0").url!=null)throw new AssertionError("current or older version offered as update");
        String debug="Cortex-Android-0.10.0-debug.apk";
        JSONObject both=new JSONObject().put("assets",new JSONArray().put(asset(debug,"https://github.com")).put(asset(name,"https://github.com")));
        if(!UpdateChecker.parse(both,"0.3.0").url.endsWith("/"+name))throw new AssertionError("release version should be preferred over debug");
        System.out.println("Update checker tests passed");
    }
}
