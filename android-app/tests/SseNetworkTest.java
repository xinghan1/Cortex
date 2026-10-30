package com.cortex.mobile;

import com.sun.net.httpserver.HttpServer;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONObject;

/** Verify that text reaches the UI callback before the server finishes the response. */
public final class SseNetworkTest {
    public static void main(String[] args) throws Exception {
        HttpServer server=HttpServer.create(new InetSocketAddress("127.0.0.1",0),0);
        CountDownLatch first=new CountDownLatch(1), release=new CountDownLatch(1);
        AtomicReference<Throwable> error=new AtomicReference<>();
        server.createContext("/v1/chat/completions",exchange->{
            try {
                JSONObject request=new JSONObject(new String(exchange.getRequestBody().readAllBytes(),StandardCharsets.UTF_8));
                if(!request.optBoolean("stream") || !"Bearer test-key".equals(exchange.getRequestHeaders().getFirst("Authorization")))throw new AssertionError("request headers or stream flag");
                exchange.getResponseHeaders().set("Content-Type","text/event-stream");exchange.sendResponseHeaders(200,0);
                exchange.getResponseBody().write("data: {\"choices\":[{\"delta\":{\"content\":\"先\"}}]}\n\n".getBytes(StandardCharsets.UTF_8));exchange.getResponseBody().flush();
                if(!release.await(5,TimeUnit.SECONDS))throw new AssertionError("client did not report first token");
                exchange.getResponseBody().write("data: {\"choices\":[{\"delta\":{\"content\":\"后\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n".getBytes(StandardCharsets.UTF_8));
            } catch(Throwable e){error.set(e);} finally {exchange.close();}
        });
        server.start();AtomicReference<JSONObject> result=new AtomicReference<>();
        Thread client=new Thread(()->{try{result.set(SseModelClient.request("http://127.0.0.1:"+server.getAddress().getPort()+"/v1","test-key","",new JSONObject(),(text,thinking)->{if("先".equals(text))first.countDown();}));}catch(Throwable e){error.set(e);}});
        try {
            client.start();if(!first.await(5,TimeUnit.SECONDS))throw new AssertionError("first token was not displayed before completion");
            release.countDown();client.join(5000);if(client.isAlive())throw new AssertionError("client did not finish");
            if(error.get()!=null)throw new AssertionError("stream request failed",error.get());
            if(!"先后".equals(result.get().getString("content")))throw new AssertionError("final answer differs from streamed text");
            System.out.println("Live SSE network test passed");
        } finally {release.countDown();server.stop(0);client.join(5000);}
    }
}
