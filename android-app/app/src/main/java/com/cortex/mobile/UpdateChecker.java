package com.cortex.mobile;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.math.BigInteger;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.json.JSONArray;
import org.json.JSONObject;

/** Checks the repository's latest release, and only offers explicitly named Android APKs. */
final class UpdateChecker {
    private static final String RELEASE="https://api.github.com/repos/xinghan1/Cortex/releases/latest";
    private static final Pattern APK=Pattern.compile("^Cortex-Android-(\\d{1,9}\\.\\d{1,9}\\.\\d{1,9})(-debug)?\\.apk$",Pattern.CASE_INSENSITIVE);
    static final class Result {
        final String message, url;
        Result(String message,String url){this.message=message;this.url=url;}
    }
    private UpdateChecker() {}
    static Result check(String current) throws Exception {
        HttpURLConnection conn=(HttpURLConnection)new URL(RELEASE).openConnection();
        conn.setInstanceFollowRedirects(false);conn.setConnectTimeout(12000);conn.setReadTimeout(15000);
        conn.setRequestProperty("Accept","application/vnd.github+json");conn.setRequestProperty("User-Agent","Cortex-Android");
        try {
            int status=conn.getResponseCode(); if(status==404)return new Result("未找到公开的 GitHub 发布版本。",null);
            if(status!=200)throw new Exception("更新服务返回 HTTP "+status);
            ByteArrayOutputStream out=new ByteArrayOutputStream();
            try(InputStream in=conn.getInputStream()){byte[] b=new byte[8192];int n;while((n=in.read(b))!=-1){if(out.size()+n>2*1024*1024)throw new Exception("更新信息过大");out.write(b,0,n);}}
            return parse(new JSONObject(new String(out.toByteArray(),StandardCharsets.UTF_8)),current);
        } finally {conn.disconnect();}
    }
    static Result parse(JSONObject release,String current) throws Exception {
        JSONArray assets=release.optJSONArray("assets");String version=null,url=null;boolean debug=false;
        if(assets!=null) for(int i=0;i<assets.length();i++){
            JSONObject item=assets.optJSONObject(i);if(item==null)continue;String name=item.optString("name","");Matcher m=APK.matcher(name);
            if(!m.matches() || !trusted(item.optString("browser_download_url",""),name))continue;
            if(version==null||compare(m.group(1),version)>0||(compare(m.group(1),version)==0&&debug&&m.group(2)==null)){version=m.group(1);url=item.optString("browser_download_url");debug=m.group(2)!=null;}
        }
        if(version==null)return new Result("最新 GitHub 发布未包含可识别的 Android 安装包。",null);
        if(compare(version,current)<=0)return new Result("当前版本 "+current+"；最新发布的 Android 版本为 "+version+"。",null);
        return new Result("发现 Android "+version+(debug?" 测试版":"")+"，点击下方按钮打开下载页面。",url);
    }
    private static boolean trusted(String value,String name){try{URI u=new URI(value);String p=u.getRawPath();return "https".equalsIgnoreCase(u.getScheme())&&"github.com".equalsIgnoreCase(u.getHost())&&u.getUserInfo()==null&&u.getPort()==-1&&u.getRawQuery()==null&&u.getRawFragment()==null&&p!=null&&p.startsWith("/xinghan1/Cortex/releases/download/")&&p.endsWith("/"+name)&&!p.contains("%")&&!p.contains("..")&&!p.contains("\\");}catch(Exception e){return false;}}
    private static int compare(String a,String b){String[] x=a.split("\\."),y=b.split("\\.");for(int i=0;i<3;i++){BigInteger left=new BigInteger(i<x.length?x[i]:"0"),right=new BigInteger(i<y.length?y[i]:"0");int c=left.compareTo(right);if(c!=0)return c;}return 0;}
}
