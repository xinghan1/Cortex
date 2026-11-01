package com.cortex.mobile;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/** First answer wins; cancellation and timeout never imply user approval. */
final class LocalQuestionWaiter {
    private final CountDownLatch latch=new CountDownLatch(1); private boolean resolved; private volatile String answer;
    synchronized void resolve(String value){if(resolved)return;resolved=true;answer=value;latch.countDown();}
    String await(long timeout,TimeUnit unit)throws InterruptedException{return latch.await(timeout,unit)?answer:null;}
}
