package com.cortex.mobile;

public final class EndpointValidationTest {
    private static void fails(String input, boolean computer, String text) throws Exception {
        try { EndpointValidation.validate(input,computer); throw new AssertionError("accepted: "+input); }
        catch(Exception e) { if(!e.getMessage().contains(text)) throw new AssertionError(e.getMessage()); }
    }
    public static void main(String[] args) throws Exception {
        fails("",true,"设置中配置电脑连接地址");
        fails("  ",true,"设置中配置电脑连接地址");
        fails(null,false,"模型设置中配置 API 地址");
        fails("example.invalid:123",true,"https://地址:端口");
        fails("http://example.invalid:123",true,"HTTPS");
        fails("https://user@example.invalid",true,"格式不正确");
        EndpointValidation.validate("https://192.168.1.2:36696",true);
        EndpointValidation.validate("https://relay.example.invalid:36699",true);
        EndpointValidation.validate("https://api.example.invalid/v1",false);
        System.out.println("Endpoint validation passed");
    }
}
