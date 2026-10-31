package com.cortex.mobile;

import org.json.JSONObject;
import java.net.URI;
import java.util.Locale;

/** Only the desktop's versioned pairing format is accepted. */
final class PairingPayload {
    final String url,fingerprint,token;
    private PairingPayload(String u,String f,String t){url=u;fingerprint=f;token=t;}
    static PairingPayload parse(String raw) throws Exception {
        if(raw==null||raw.length()>2048)throw new IllegalArgumentException("二维码格式无效");
        if(raw.indexOf('\\')>=0)throw new IllegalArgumentException("二维码格式无效");
        org.json.JSONTokener reader=new org.json.JSONTokener(raw);Object value=reader.nextValue();if(!(value instanceof JSONObject)||reader.nextClean()!=0)throw new IllegalArgumentException("二维码格式无效");JSONObject json=(JSONObject)value;
        java.util.regex.Matcher keys=java.util.regex.Pattern.compile("\"(?:v|url|fingerprint|token)\"\\s*:").matcher(raw);int keyCount=0;while(keys.find())keyCount++;if(keyCount!=4)throw new IllegalArgumentException("二维码字段无效");
        if(json.length()!=4 || !json.has("v") || !(json.get("v") instanceof Number) || ((Number)json.get("v")).doubleValue()!=1 || !(json.opt("url") instanceof String) || !(json.opt("fingerprint") instanceof String) || !(json.opt("token") instanceof String))throw new IllegalArgumentException("不是 Cortex 配对二维码");
        String address=json.getString("url"),fp=json.getString("fingerprint"),token=json.getString("token"); URI u=new URI(address);
        if(!"https".equalsIgnoreCase(u.getScheme()) || u.getRawUserInfo()!=null || u.getRawQuery()!=null || u.getRawFragment()!=null || (u.getRawPath()!=null&&!u.getRawPath().isEmpty()) || u.getPort()<1 || u.getPort()>65535 || !validHost(u.getHost()))throw new IllegalArgumentException("电脑地址无效");
        if(!fp.matches("(?i)(?:[0-9a-f]{2}:){31}[0-9a-f]{2}") || !token.matches("[A-Za-z0-9_-]{43}"))throw new IllegalArgumentException("证书或连接令牌无效");
        return new PairingPayload(address,fp.toUpperCase(Locale.ROOT),token);
    }
    private static boolean validHost(String host) {
        if(host==null || host.length()>253 || host.isEmpty())return false;
        if(host.matches("[0-9.]+")) {
            String[] parts=host.split("\\.",-1);
            if(parts.length!=4)return false;
            for(String part:parts) {
                if(!part.matches("[0-9]{1,3}") || (part.length()>1&&part.startsWith("0")) || Integer.parseInt(part)>255)return false;
            }
            return true;
        }
        // ASCII DNS names (including punycode), with no empty labels or URL delimiters.
        for(String label:host.split("\\.",-1)) {
            if(label.length()<1 || label.length()>63 || !label.matches("[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?"))return false;
        }
        return true;
    }
}
