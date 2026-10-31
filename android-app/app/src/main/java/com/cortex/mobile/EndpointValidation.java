package com.cortex.mobile;

import java.net.MalformedURLException;
import java.net.URL;

/** Validate connection addresses with actionable messages for missing or malformed input. */
final class EndpointValidation {
    private EndpointValidation() {}
    static void validate(String value, boolean computer) throws Exception {
        if(value==null || value.trim().isEmpty()) throw new Exception(computer ? "请先在设置中配置电脑连接地址" : "请先在模型设置中配置 API 地址");
        final URL url;
        try { url=new URL(value); }
        catch(MalformedURLException e) { throw new Exception(computer ? "电脑连接地址格式不正确，请填写 https://地址:端口" : "模型 API 地址格式不正确，请填写 HTTPS 地址"); }
        if(url.getUserInfo()!=null || url.getQuery()!=null || url.getRef()!=null) throw new Exception("地址格式不正确");
        if(!"https".equalsIgnoreCase(url.getProtocol())) throw new Exception("连接地址须使用 HTTPS");
        if(url.getHost()==null || url.getHost().isEmpty()) throw new Exception("连接地址缺少主机名");
    }
}
