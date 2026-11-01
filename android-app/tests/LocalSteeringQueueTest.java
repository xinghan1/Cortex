package com.cortex.mobile;
public class LocalSteeringQueueTest {
    public static void main(String[] args) {
        LocalSteeringQueue queue=new LocalSteeringQueue();queue.start("A");
        if(!queue.offer("A","first")||queue.offer("B","other"))throw new AssertionError("session isolation");
        if(queue.finishIfEmpty())throw new AssertionError("cannot finish with queued steering");
        if(!queue.drain().get(0).text.equals("first"))throw new AssertionError("delivery");
        if(!queue.offer("A","second")||!queue.close().get(0).text.equals("second"))throw new AssertionError("close keeps pending");
        if(queue.offer("A","lost"))throw new AssertionError("closed turn rejected");
        queue.start("B");if(!queue.finishIfEmpty()||queue.offer("B","late"))throw new AssertionError("finish boundary");
        queue.start("C");queue.setJournal((id,entries)->false);if(queue.offer("C","unsaved"))throw new AssertionError("reject if journal cannot persist");
        System.out.println("Local steering queue passed");
    }
}
