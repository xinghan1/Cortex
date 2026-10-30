package com.cortex.mobile;

import java.io.StringReader;
import org.json.JSONArray;
import org.json.JSONObject;

public final class SseModelClientTest {
    private static void check(boolean ok,String message){if(!ok)throw new AssertionError(message);}
    private static String sse(String json){return "data: "+json+"\n\n";}
    public static void main(String[] args)throws Exception{
        final String[] visible={"",""}; SseModelClient.Listener listener=(text,think)->{visible[0]=text;visible[1]=think;};
        String open=sse("{\"choices\":[{\"delta\":{\"content\":\"Hello\"}}]}")
            +sse("{\"choices\":[{\"delta\":{\"content\":\" world\",\"tool_calls\":[{\"index\":0,\"id\":\"c1\",\"function\":{\"name\":\"read_file\",\"arguments\":\"{\\\"path\\\":\"}}]}}]}")
            +sse("{\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"\\\"a.txt\\\"}\"}}]},\"finish_reason\":\"tool_calls\"}]}")+sse("[DONE]");
        JSONObject result=SseModelClient.parse(new StringReader(open),false,listener);
        check("Hello world".equals(visible[0]),"partial text");
        check("a.txt".equals(new JSONObject(result.getJSONArray("tool_calls").getJSONObject(0).getJSONObject("function").getString("arguments")).getString("path")),"fragmented tool arguments");
        boolean failed=false;try{SseModelClient.parse(new StringReader(open.replace(sse("[DONE]"),"")),false,listener);}catch(Exception expected){failed=true;}check(failed,"incomplete stream must fail before tools run");
        String anthropic=sse("{\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"thinking\",\"thinking\":\"\"}}")
            +sse("{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\"consider\"}}")
            +sse("{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"signature_delta\",\"signature\":\"sig\"}}")
            +sse("{\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"tool_use\",\"id\":\"t1\",\"name\":\"read_file\",\"input\":{}}}")
            +sse("{\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"path\\\":\\\"a\\\"}\"}}")
            +sse("{\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\"}}")+sse("{\"type\":\"message_stop\"}");
        JSONObject ar=SseModelClient.parse(new StringReader(anthropic),true,listener);JSONArray blocks=ar.getJSONArray("messages_content");
        check("consider".equals(visible[1])&&"sig".equals(blocks.getJSONObject(0).getString("signature")),"thinking signature lost");
        check("a".equals(blocks.getJSONObject(1).getJSONObject("input").getString("path")),"Anthropic arguments lost");
        boolean invalid=false;try{SseModelClient.parse(new StringReader(anthropic.replace("a\\\"}","a\\\"")),true,listener);}catch(Exception expected){invalid=true;}check(invalid,"malformed tool JSON must fail");
        System.out.println("SSE parser tests passed");
    }
}
