package com.cortex.mobile;
import java.util.concurrent.TimeUnit;
public class LocalQuestionWaiterTest {
    public static void main(String[] args)throws Exception {
        LocalQuestionWaiter q=new LocalQuestionWaiter();q.resolve("first");q.resolve("second");if(!"first".equals(q.await(1,TimeUnit.MILLISECONDS)))throw new AssertionError("first response wins");
        LocalQuestionWaiter cancelled=new LocalQuestionWaiter();cancelled.resolve(null);cancelled.resolve("late");if(cancelled.await(1,TimeUnit.MILLISECONDS)!=null)throw new AssertionError("cancellation");
        LocalQuestionWaiter timedOut=new LocalQuestionWaiter();if(timedOut.await(1,TimeUnit.MILLISECONDS)!=null)throw new AssertionError("timeout");
        System.out.println("Local question wait passed");
    }
}
