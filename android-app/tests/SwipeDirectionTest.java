package com.cortex.mobile;

public final class SwipeDirectionTest {
    public static void main(String[] args) {
        if(SwipeDirection.recognize(-110,12,200,80)!=-1) throw new AssertionError("left swipe");
        if(SwipeDirection.recognize(110,12,200,80)!=1) throw new AssertionError("right swipe");
        if(SwipeDirection.recognize(110,90,200,80)!=0) throw new AssertionError("vertical scroll");
        if(SwipeDirection.recognize(110,12,1000,80)!=0) throw new AssertionError("long press");
        if(SwipeDirection.recognize(30,2,100,80)!=0) throw new AssertionError("tap");
        System.out.println("Swipe recognition passed");
    }
}
