package com.cortex.mobile;

import android.content.Context;
import android.content.SharedPreferences;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.Locale;
import java.util.UUID;

/** Persistent local chats. The previous single-chat preference is retained for recovery. */
final class SessionStore {
    private static final String DATA = "chat_sessions_v1", CURRENT = "chat_current_v1";
    private final SharedPreferences prefs;
    private JSONArray sessions;
    private String current;

    SessionStore(Context context, SharedPreferences prefs) {
        this.prefs = prefs;
        String raw = prefs.getString(DATA, null);
        try { sessions = raw == null ? new JSONArray() : new JSONArray(raw); }
        catch (Exception e) { throw new IllegalStateException("无法读取会话历史，请保留应用数据以恢复", e); }
        current = prefs.getString(CURRENT, "");
        if (sessions.length() == 0) {
            JSONArray old;
            try { old = new JSONArray(prefs.getString("messages", "[]")); }
            catch (Exception e) { throw new IllegalStateException("无法读取原有会话，请保留应用数据以恢复", e); }
            current = newSession(old);
            persist();
        } else if (find(current) == null) {
            JSONObject first = sessions.optJSONObject(0);
            current = first == null ? "" : first.optString("id", "");
            if (current.isEmpty()) throw new IllegalStateException("会话历史格式无效");
            persist();
        }
    }

    private JSONObject find(String id) {
        for (int i=0; i<sessions.length(); i++) {
            JSONObject s = sessions.optJSONObject(i);
            if (s != null && s.optString("id").equals(id)) return s;
        }
        return null;
    }
    private String newSession(JSONArray messages) {
        try {
            String id = UUID.randomUUID().toString();
            long now = System.currentTimeMillis();
            sessions.put(new JSONObject().put("id", id).put("title", title(messages)).put("createdAt", now)
                    .put("updatedAt", now).put("messages", new JSONArray(messages.toString())));
            return id;
        } catch (Exception e) { throw new IllegalStateException("无法创建会话", e); }
    }
    private static String title(JSONArray messages) {
        for (int i=0; i<messages.length(); i++) {
            JSONObject m=messages.optJSONObject(i);
            if (m == null || !"user".equals(m.optString("role"))) continue;
            String text=m.optString("content", "").trim().replaceAll("\\s+", " ");
            if (!text.isEmpty()) return text.codePointCount(0, text.length()) > 40
                    ? text.substring(0, text.offsetByCodePoints(0, 40)) + "…" : text;
        }
        return "新会话";
    }
    private void persist() {
        if (!prefs.edit().putString(DATA, sessions.toString()).putString(CURRENT, current).commit())
            throw new IllegalStateException("保存会话失败，请检查手机存储空间");
    }
    synchronized String currentId() { return current; }
    synchronized JSONArray load(String id) {
        JSONObject item=find(id);
        if (item == null) throw new IllegalArgumentException("会话不存在");
        try { return new JSONArray(item.optJSONArray("messages").toString()); }
        catch (Exception e) { throw new IllegalStateException("无法读取会话", e); }
    }
    synchronized void save(String id, JSONArray messages) {
        JSONObject item=find(id);
        if (item == null) throw new IllegalArgumentException("会话不存在");
        try {
            item.put("messages", new JSONArray(messages.toString()));
            item.put("title", title(messages));
            item.put("updatedAt", System.currentTimeMillis());
            persist();
        } catch (org.json.JSONException e) { throw new IllegalStateException("无法保存会话", e); }
    }
    synchronized String create() {
        current = newSession(new JSONArray()); persist(); return current;
    }
    synchronized void select(String id) {
        if (find(id) == null) throw new IllegalArgumentException("会话不存在");
        current=id; persist();
    }
    synchronized void delete(String id) {
        int index=-1;
        for (int i=0; i<sessions.length(); i++) if (sessions.optJSONObject(i)!=null && id.equals(sessions.optJSONObject(i).optString("id"))) { index=i; break; }
        if (index<0) throw new IllegalArgumentException("会话不存在");
        sessions.remove(index);
        if (sessions.length()==0) current=newSession(new JSONArray());
        else if (id.equals(current)) current=sessions.optJSONObject(0).optString("id");
        persist();
    }
    synchronized JSONArray list(String query) {
        String needle = query == null ? "" : query.trim().toLowerCase(Locale.ROOT);
        ArrayList<JSONObject> found=new ArrayList<>();
        for(int i=0; i<sessions.length(); i++) {
            JSONObject s=sessions.optJSONObject(i); if(s==null) continue;
            StringBuilder text=new StringBuilder(s.optString("title", ""));
            JSONArray messages=s.optJSONArray("messages");
            if (messages!=null) for(int j=0;j<messages.length();j++) {
                JSONObject m=messages.optJSONObject(j);
                if(m!=null && ("user".equals(m.optString("role")) || "assistant".equals(m.optString("role")))) text.append(' ').append(m.optString("content", ""));
            }
            if(needle.isEmpty() || text.toString().toLowerCase(Locale.ROOT).contains(needle)) found.add(s);
        }
        Collections.sort(found, Comparator.comparingLong((JSONObject s) -> s.optLong("updatedAt", 0)).reversed());
        JSONArray result=new JSONArray();
        try { for(JSONObject s:found) result.put(new JSONObject().put("id",s.optString("id")).put("title",s.optString("title")).put("createdAt",s.optLong("createdAt")).put("updatedAt",s.optLong("updatedAt"))); }
        catch(Exception e) { throw new IllegalStateException("无法读取会话列表", e); }
        return result;
    }
}
