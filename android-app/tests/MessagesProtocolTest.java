package com.cortex.mobile;

import org.json.JSONArray;
import org.json.JSONObject;

/** Run with a JVM org.json implementation; checks message and tool round trips. */
public final class MessagesProtocolTest {
    public static void main(String[] args) throws Exception {
        JSONArray defs = new JSONArray("[{\"type\":\"function\",\"function\":{\"name\":\"read_file\",\"parameters\":{\"type\":\"object\"}}}]");
        JSONObject response = new JSONObject("{\"content\":[{\"type\":\"text\",\"text\":\"checking\"},{\"type\":\"tool_use\",\"id\":\"t1\",\"name\":\"read_file\",\"input\":{\"path\":\"a.txt\"}},{\"type\":\"tool_use\",\"id\":\"t2\",\"name\":\"read_file\",\"input\":{\"path\":\"b.txt\"}}]}");
        JSONObject reply = MessagesProtocol.reply(response);
        JSONArray history = new JSONArray().put(new JSONObject().put("role","user").put("content","null").put("attachments",new JSONArray().put(new JSONObject().put("mediaType","image/jpeg").put("dataUrl","data:image/jpeg;base64,YWJj")))).put(reply)
                .put(new JSONObject().put("role","tool").put("tool_call_id","t1").put("content","first"))
                .put(new JSONObject().put("role","tool").put("tool_call_id","t2").put("content","second"));
        JSONObject request = MessagesProtocol.request("claude-test", history, defs);
        JSONArray messages = request.getJSONArray("messages");
        if (!"null".equals(messages.getJSONObject(0).getJSONArray("content").getJSONObject(0).getString("text"))) throw new AssertionError("text changed");
        JSONObject image=messages.getJSONObject(0).getJSONArray("content").getJSONObject(1);
        if (!"image".equals(image.getString("type")) || !"YWJj".equals(image.getJSONObject("source").getString("data"))) throw new AssertionError("image lost");
        JSONArray assistant = messages.getJSONObject(1).getJSONArray("content");
        if (assistant.length() != 3 || !"a.txt".equals(assistant.getJSONObject(1).getJSONObject("input").getString("path"))) throw new AssertionError("tool use lost");
        JSONArray results = messages.getJSONObject(2).getJSONArray("content");
        if (results.length() != 2 || !"t2".equals(results.getJSONObject(1).getString("tool_use_id"))) throw new AssertionError("tool results lost");
        if (!request.getJSONArray("tools").getJSONObject(0).has("input_schema")) throw new AssertionError("schema missing");
        System.out.println("Messages protocol round-trip passed");
    }
}
