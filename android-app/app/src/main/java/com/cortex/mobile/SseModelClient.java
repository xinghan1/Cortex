package com.cortex.mobile;

import org.json.JSONArray;
import org.json.JSONObject;
import java.io.*;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.TreeMap;

/** Bounded SSE decoding; no tools are returned for execution before a complete response. */
final class SseModelClient {
    interface Listener { void update(String text,String thinking); }
    private static final int MAX=4_000_000;
    private SseModelClient() {}
    static JSONObject request(String base,String token,String auth,JSONObject data,Listener listener) throws Exception {
        boolean messages="anthropic".equals(auth)||"deepseek-account".equals(auth);
        String root=base.replaceAll("/+$","");
        if("deepseek-account".equals(auth)&&!"https://api.deepseek.com/anthropic/v1".equals(root))throw new IOException("DeepSeek 账号只能连接官方地址");
        HttpURLConnection conn=(HttpURLConnection)new URL(root+(messages?"/messages":"/chat/completions")).openConnection();
        conn.setInstanceFollowRedirects(false);conn.setConnectTimeout(15000);conn.setReadTimeout(120000);conn.setRequestMethod("POST");conn.setDoOutput(true);
        conn.setRequestProperty("Content-Type","application/json; charset=utf-8");conn.setRequestProperty("Accept","text/event-stream, application/json");
        if("deepseek-account".equals(auth)){conn.setRequestProperty("x-dsh-auth-token",token);conn.setRequestProperty("anthropic-version","2023-06-01");}
        else if(messages){conn.setRequestProperty("x-api-key",token);conn.setRequestProperty("anthropic-version","2023-06-01");}
        else conn.setRequestProperty("Authorization","Bearer "+token);
        data.put("stream",true);
        try {
            try(OutputStream out=conn.getOutputStream()){out.write(data.toString().getBytes(StandardCharsets.UTF_8));}
            int status=conn.getResponseCode();if(status<200||status>=300)throw new IOException("HTTP "+status);
            try(InputStream input=conn.getInputStream()){
                String type=conn.getContentType();
                if(type!=null&&type.toLowerCase(java.util.Locale.ROOT).contains("application/json")){
                    ByteArrayOutputStream out=new ByteArrayOutputStream();byte[] buf=new byte[8192];int n;while((n=input.read(buf))!=-1){if(out.size()+n>MAX)throw new IOException("响应过大");out.write(buf,0,n);}
                    JSONObject body=new JSONObject(new String(out.toByteArray(),StandardCharsets.UTF_8));JSONObject choice=messages?null:body.getJSONArray("choices").getJSONObject(0);
                    String reason=messages?body.optString("stop_reason",""):choice.optString("finish_reason","");
                    if("length".equals(reason)||"max_tokens".equals(reason)||"content_filter".equals(reason))throw new IOException("模型响应未完整结束");
                    JSONObject reply=messages?MessagesProtocol.reply(body):choice.getJSONObject("message");JSONArray calls=reply.optJSONArray("tool_calls");
                    if(calls!=null)for(int i=0;i<calls.length();i++){JSONObject call=calls.getJSONObject(i),fn=call.getJSONObject("function");if(call.optString("id").isEmpty()||fn.optString("name").isEmpty())throw new IOException("工具调用不完整");new JSONObject(fn.optString("arguments","{}"));}
                    listener.update(reply.optString("content",""),"");return reply;
                }
                return parse(new InputStreamReader(input,StandardCharsets.UTF_8),messages,listener);
            }
        } finally {conn.disconnect();}
    }
    static JSONObject parse(Reader source,boolean messages,Listener listener) throws Exception {
        BufferedReader in=new BufferedReader(source);String line;StringBuilder event=new StringBuilder();int total=0; Accumulator acc=new Accumulator(messages,listener);
        try {
            while((line=in.readLine())!=null){total+=line.length()+1;if(total>MAX)throw new IOException("流式响应过大");
                if(line.isEmpty()){if(event.length()>0){acc.event(event.toString());event.setLength(0);}continue;}
                if(line.startsWith("data:")){if(event.length()>0)event.append('\n');String data=line.substring(5);if(data.startsWith(" "))data=data.substring(1);event.append(data);}
            }
            if(event.length()>0)acc.event(event.toString());return acc.finish();
        } catch(Exception failure) { acc.forceUpdate();throw failure; }
    }
    private static final class Accumulator {
        final boolean messages; final Listener listener; final StringBuilder text=new StringBuilder(),thinking=new StringBuilder();
        final TreeMap<Integer,JSONObject> blocks=new TreeMap<>(),calls=new TreeMap<>(); final TreeMap<Integer,StringBuilder> json=new TreeMap<>();
        boolean complete; String reason=""; long lastUpdate;
        Accumulator(boolean messages,Listener listener){this.messages=messages;this.listener=listener;}
        void update(){long now=System.currentTimeMillis();if(now-lastUpdate>=50){lastUpdate=now;forceUpdate();}}
        void forceUpdate(){listener.update(text.toString(),thinking.toString());}
        void event(String raw) throws Exception {
            if("[DONE]".equals(raw)){if(!messages)complete=true;return;}
            JSONObject e=new JSONObject(raw);if(e.has("error")||"error".equals(e.optString("type")))throw new IOException("模型返回流式错误");
            if(messages){
                String kind=e.optString("type");int index=e.optInt("index",-1);
                if("message_stop".equals(kind)){complete=true;return;}
                if("message_delta".equals(kind)){reason=e.optJSONObject("delta")==null?"":e.optJSONObject("delta").optString("stop_reason","");return;}
                if("content_block_start".equals(kind)){JSONObject block=e.getJSONObject("content_block");blocks.put(index,new JSONObject(block.toString()));String k=block.optString("type");if("text".equals(k)){text.append(block.optString("text",""));update();}else if("thinking".equals(k)){thinking.append(block.optString("thinking",""));update();}return;}
                if("content_block_delta".equals(kind)){JSONObject d=e.getJSONObject("delta"),b=blocks.get(index);if(b==null)throw new IOException("流式内容块无效");String k=d.optString("type");
                    if("text_delta".equals(k)){String t=d.optString("text","");b.put("text",b.optString("text","")+t);text.append(t);update();}
                    else if("thinking_delta".equals(k)){String t=d.optString("thinking","");b.put("thinking",b.optString("thinking","")+t);thinking.append(t);update();}
                    else if("signature_delta".equals(k))b.put("signature",b.optString("signature","")+d.optString("signature",""));
                    else if("input_json_delta".equals(k))json.computeIfAbsent(index,x->new StringBuilder()).append(d.optString("partial_json",""));
                } return;
            }
            JSONArray choices=e.optJSONArray("choices");if(choices==null||choices.length()==0)return;JSONObject choice=choices.getJSONObject(0);if(!choice.isNull("finish_reason"))reason=choice.optString("finish_reason","");
            JSONObject delta=choice.optJSONObject("delta");if(delta==null)return;
            if(!delta.isNull("content")){String t=delta.optString("content","");text.append(t);update();}
            String thoughts=delta.optString("reasoning_content",delta.optString("reasoning",""));if(!thoughts.isEmpty()&&!"null".equals(thoughts)){thinking.append(thoughts);update();}
            JSONArray incoming=delta.optJSONArray("tool_calls");if(incoming!=null)for(int j=0;j<incoming.length();j++){JSONObject piece=incoming.getJSONObject(j);int index=piece.optInt("index",j);JSONObject call=calls.get(index);if(call==null){call=new JSONObject().put("id","").put("type","function").put("function",new JSONObject().put("name","").put("arguments",""));calls.put(index,call);}if(!piece.isNull("id"))call.put("id",call.optString("id")+piece.optString("id",""));JSONObject f=piece.optJSONObject("function");if(f!=null){JSONObject target=call.getJSONObject("function");if(!f.isNull("name"))target.put("name",target.optString("name")+f.optString("name",""));if(!f.isNull("arguments"))target.put("arguments",target.optString("arguments")+f.optString("arguments",""));}}
        }
        JSONObject finish() throws Exception {
            if(!complete)throw new IOException("流式响应中断，请重试");
            if("length".equals(reason)||"max_tokens".equals(reason)||"content_filter".equals(reason))throw new IOException("模型响应未完整结束");
            JSONObject reply=new JSONObject().put("role","assistant").put("content",text.toString());JSONArray resultCalls=new JSONArray();
            if(messages){JSONArray content=new JSONArray();for(Map.Entry<Integer,JSONObject> item:blocks.entrySet()){JSONObject block=item.getValue();if("tool_use".equals(block.optString("type"))){StringBuilder fragments=json.get(item.getKey());JSONObject input=fragments==null?block.optJSONObject("input"):new JSONObject(fragments.toString());if(input==null)throw new IOException("工具参数无效");block.put("input",input);resultCalls.put(new JSONObject().put("id",block.getString("id")).put("type","function").put("function",new JSONObject().put("name",block.getString("name")).put("arguments",input.toString())));}content.put(block);}if(resultCalls.length()>0)reply.put("messages_content",content);}
            else for(JSONObject call:calls.values()){JSONObject f=call.getJSONObject("function");if(call.optString("id").isEmpty()||f.optString("name").isEmpty())throw new IOException("工具调用不完整");new JSONObject(f.optString("arguments","{}"));resultCalls.put(call);}
            if(resultCalls.length()>0)reply.put("tool_calls",resultCalls);forceUpdate();return reply;
        }
    }
}
