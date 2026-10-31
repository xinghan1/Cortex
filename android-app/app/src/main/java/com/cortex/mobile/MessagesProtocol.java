package com.cortex.mobile;

import org.json.JSONArray;
import org.json.JSONObject;

/** Translation between the app's saved conversation format and Messages APIs. */
final class MessagesProtocol {
    private MessagesProtocol() {}

    static JSONObject request(String model, JSONArray history, JSONArray definitions) throws Exception {
        JSONArray messages = new JSONArray(), tools = new JSONArray();
        for (int i = 0; i < definitions.length(); i++) {
            JSONObject f = definitions.getJSONObject(i).getJSONObject("function");
            tools.put(new JSONObject().put("name", f.getString("name"))
                    .put("description", f.optString("description", ""))
                    .put("input_schema", f.getJSONObject("parameters")));
        }
        for (int i = 0; i < history.length(); i++) {
            JSONObject m = history.getJSONObject(i); String role = m.optString("role");
            if (role.equals("tool")) {
                JSONArray results = new JSONArray();
                do {
                    results.put(new JSONObject().put("type", "tool_result")
                            .put("tool_use_id", m.getString("tool_call_id")).put("content", m.optString("content", "")));
                    if (i + 1 >= history.length() || !"tool".equals(history.getJSONObject(i + 1).optString("role"))) break;
                    m = history.getJSONObject(++i);
                } while (true);
                messages.put(new JSONObject().put("role", "user").put("content", results));
            } else if (role.equals("user") || role.equals("assistant")) {
                JSONArray original = m.optJSONArray("messages_content");
                if (role.equals("assistant") && original != null && original.length() > 0) {
                    messages.put(new JSONObject().put("role", role).put("content", new JSONArray(original.toString())));
                    continue;
                }
                JSONArray blocks = new JSONArray(); String text = m.isNull("content") ? "" : m.optString("content", "");
                if (!text.isEmpty()) blocks.put(new JSONObject().put("type", "text").put("text", text));
                JSONArray images = m.optJSONArray("attachments");
                if (images != null) for (int j = 0; j < images.length(); j++) {
                    JSONObject image = images.getJSONObject(j); String media = image.getString("mediaType"), url = image.getString("dataUrl");
                    String prefix = "data:" + media + ";base64,";
                    if (!("image/jpeg".equals(media)||"image/png".equals(media)||"image/webp".equals(media)) || !url.startsWith(prefix)) throw new IllegalArgumentException("图片格式无效");
                    blocks.put(new JSONObject().put("type", "image").put("source", new JSONObject().put("type", "base64").put("media_type", media).put("data", url.substring(prefix.length()))));
                }
                JSONArray calls = m.optJSONArray("tool_calls");
                if (calls != null) for (int j = 0; j < calls.length(); j++) {
                    JSONObject call = calls.getJSONObject(j), f = call.getJSONObject("function");
                    blocks.put(new JSONObject().put("type", "tool_use").put("id", call.getString("id"))
                            .put("name", f.getString("name")).put("input", new JSONObject(f.optString("arguments", "{}"))));
                }
                if (blocks.length() > 0) messages.put(new JSONObject().put("role", role).put("content", blocks));
            }
        }
        JSONObject data = new JSONObject().put("model", model).put("messages", messages).put("max_tokens", 8192).put("stream", false);
        if (tools.length() > 0) data.put("tools", tools);
        return data;
    }

    static JSONObject reply(JSONObject response) throws Exception {
        JSONArray content = response.getJSONArray("content"), calls = new JSONArray(); StringBuilder text = new StringBuilder();
        for (int i = 0; i < content.length(); i++) {
            JSONObject block = content.getJSONObject(i); String type = block.optString("type");
            if (type.equals("text")) text.append(block.optString("text", ""));
            else if (type.equals("tool_use")) calls.put(new JSONObject().put("id", block.getString("id")).put("type", "function")
                    .put("function", new JSONObject().put("name", block.getString("name"))
                            .put("arguments", block.getJSONObject("input").toString())));
        }
        JSONObject result = new JSONObject().put("role", "assistant").put("content", text.toString());
        if (calls.length() > 0) result.put("tool_calls", calls).put("messages_content", new JSONArray(content.toString()));
        return result;
    }
}
