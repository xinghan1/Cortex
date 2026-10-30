package com.cortex.mobile;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.util.Base64;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.UUID;
import javax.net.ssl.HttpsURLConnection;

/** DeepSeek's published desktop PKCE protocol, using the system browser and loopback only. */
final class DeepSeekAccount {
    interface Callback { void onSuccess(String token); void onError(String message); }
    private static final String PLATFORM = "https://platform.deepseek.com";
    private static final SecureRandom RANDOM = new SecureRandom();
    private static volatile boolean active;
    private static String random() { byte[] value=new byte[32]; RANDOM.nextBytes(value); return Base64.encodeToString(value,Base64.URL_SAFE|Base64.NO_PADDING|Base64.NO_WRAP); }
    private static JSONObject request(String url, JSONObject body, String token) throws Exception {
        HttpsURLConnection c=(HttpsURLConnection)new URL(url).openConnection();
        c.setInstanceFollowRedirects(false); c.setConnectTimeout(15000); c.setReadTimeout(30000);
        c.setRequestProperty("Accept","application/json"); c.setRequestProperty("User-Agent","Cortex-Android/0.2");
        if(url.startsWith(PLATFORM+"/")) { c.setRequestProperty("x-client-bundle-id",""); c.setRequestProperty("x-client-platform","web"); c.setRequestProperty("x-client-version","0.2.1"); c.setRequestProperty("x-client-locale","zh_CN"); c.setRequestProperty("x-client-timezone-offset",String.valueOf(java.util.TimeZone.getDefault().getOffset(System.currentTimeMillis())/1000)); }
        if(token!=null) c.setRequestProperty("x-dsh-auth-token",token);
        if(body!=null) { c.setRequestMethod("POST"); c.setRequestProperty("Content-Type","application/json"); c.setDoOutput(true); try(OutputStream out=c.getOutputStream()) { out.write(body.toString().getBytes(StandardCharsets.UTF_8)); } }
        try { int status=c.getResponseCode(); if(status!=200) throw new IOException("DeepSeek 请求失败（HTTP "+status+"）");
            try(InputStream in=c.getInputStream(); ByteArrayOutputStream out=new ByteArrayOutputStream()) { byte[] b=new byte[8192]; int n; while((n=in.read(b))!=-1) { if(out.size()+n>2*1024*1024) throw new IOException("响应过大"); out.write(b,0,n); } return new JSONObject(out.toString("UTF-8")); }
        } finally { c.disconnect(); }
    }
    private static JSONObject platform(String path,JSONObject body) throws Exception {
        JSONObject root=request(PLATFORM+path,body,null), data=root.optJSONObject("data");
        if(root.optInt("code",-1)!=0 || data==null || data.optInt("biz_code",-1)!=0 || data.optJSONObject("biz_data")==null) throw new IOException("DeepSeek 授权响应无效");
        return data.getJSONObject("biz_data");
    }
    static JSONArray listModels(String token) throws Exception {
        if(token==null || token.isEmpty()) throw new IOException("请先登录 DeepSeek 账号");
        JSONArray source=request("https://api.deepseek.com/models",null,token).optJSONArray("data"), result=new JSONArray();
        if(source==null) throw new IOException("DeepSeek 模型目录无效");
        for(int i=0;i<source.length() && result.length()<500;i++) { JSONObject row=source.optJSONObject(i); if(row!=null) { String id=row.optString("id",""); if(!id.isEmpty() && id.length()<=200) result.put(id); } }
        return result;
    }
    static synchronized void signIn(Activity activity,Callback callback) {
        if(active) { callback.onError("DeepSeek 登录正在进行"); return; } active=true;
        new Thread(() -> {
            try(ServerSocket server=new ServerSocket(0,8,InetAddress.getByName("127.0.0.1"))) {
                server.setSoTimeout(180000);
                String verifier=random(), state=random(), redirect="http://127.0.0.1:"+server.getLocalPort()+"/oauth/callback";
                String challenge=Base64.encodeToString(MessageDigest.getInstance("SHA-256").digest(verifier.getBytes(StandardCharsets.US_ASCII)),Base64.URL_SAFE|Base64.NO_PADDING|Base64.NO_WRAP);
                JSONObject init=platform("/auth-api/v0/dsh/auth_init",new JSONObject().put("code_challenge",challenge).put("code_challenge_method","S256").put("state",state).put("redirect_uri",redirect).put("locale","zh_CN").put("login_source","desktop"));
                Uri authorize=Uri.parse(init.optString("authorize_url",""));
                if(!"https".equals(authorize.getScheme()) || !"platform.deepseek.com".equals(authorize.getHost()) || !"/dsh/authorize".equals(authorize.getPath()) || authorize.getUserInfo()!=null || authorize.getPort()!=-1 || authorize.getFragment()!=null) throw new IOException("DeepSeek 授权地址无效");
                activity.runOnUiThread(() -> { try { activity.startActivity(new Intent(Intent.ACTION_VIEW,authorize)); } catch(Exception ignored) { try { server.close(); } catch(Exception ignored2) {} } });
                long deadline=System.currentTimeMillis()+Math.min(180000L,Math.max(1000L,init.optLong("expires_in",180)*1000));
                while(System.currentTimeMillis()<deadline) {
                    server.setSoTimeout((int)Math.max(1,Math.min(30000,deadline-System.currentTimeMillis())));
                    try(Socket socket=server.accept()) {
                        socket.setSoTimeout(5000); BufferedReader in=new BufferedReader(new InputStreamReader(socket.getInputStream(),StandardCharsets.US_ASCII)); String line=in.readLine();
                        if(line==null || line.length()>10000 || !line.startsWith("GET ") || !line.endsWith(" HTTP/1.1")) continue;
                        String host=null, header; int count=0; while((header=in.readLine())!=null && !header.isEmpty() && count++<50) { if(header.length()>8192) throw new IOException("回调无效"); if(header.regionMatches(true,0,"Host:",0,5)) host=header.substring(5).trim(); }
                        Uri uri=Uri.parse("http://127.0.0.1:"+server.getLocalPort()+line.substring(4,line.length()-9));
                        String receivedState=uri.getQueryParameter("state"), code=uri.getQueryParameter("code");
                        if(!("127.0.0.1:"+server.getLocalPort()).equals(host) || !"/oauth/callback".equals(uri.getPath()) || uri.getQueryParameters("state").size()!=1 || uri.getQueryParameters("code").size()!=1 || receivedState==null || !MessageDigest.isEqual(state.getBytes(StandardCharsets.US_ASCII),receivedState.getBytes(StandardCharsets.US_ASCII)) || code==null || code.isEmpty() || code.length()>8192) { socket.getOutputStream().write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n".getBytes(StandardCharsets.US_ASCII)); continue; }
                        JSONObject grant=platform("/auth-api/v0/dsh/auth_exchange",new JSONObject().put("code",code).put("code_verifier",verifier).put("redirect_uri",redirect).put("device_id",UUID.randomUUID().toString()).put("device_model","android-"+Build.MODEL).put("os_version","Android "+Build.VERSION.RELEASE));
                        String token=grant.optString("token",""); Uri done=Uri.parse(grant.optString("authorized_url",""));
                        if(!token.matches("[\\x21-\\x7e]{1,8192}") || !"https".equals(done.getScheme()) || !"platform.deepseek.com".equals(done.getHost()) || !"/dsh/authorized".equals(done.getPath()) || done.getUserInfo()!=null || done.getPort()!=-1 || done.getFragment()!=null) throw new IOException("DeepSeek 登录响应无效");
                        String location=done.buildUpon().appendQueryParameter("login_source","desktop").build().toString(); socket.getOutputStream().write(("HTTP/1.1 303 See Other\r\nLocation: "+location+"\r\nCache-Control: no-store\r\nConnection: close\r\nContent-Length: 0\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
                        activity.runOnUiThread(() -> callback.onSuccess(token)); return;
                    } catch(SocketTimeoutException ignored) { /* Continue until authorization deadline. */ }
                }
                throw new IOException("DeepSeek 登录超时，请重试");
            } catch(Exception ex) { activity.runOnUiThread(() -> callback.onError(ex instanceof SocketTimeoutException ? "DeepSeek 登录超时，请重试。" : "DeepSeek 登录未完成，请检查网络和账号后重试。")); }
            finally { active=false; }
        },"cortex-deepseek-login").start();
    }
}
