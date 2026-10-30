package com.cortex.mobile;

/** Conservative recognition so vertical scrolling and long presses remain unaffected. */
final class SwipeDirection {
    private SwipeDirection() {}
    static int recognize(float dx,float dy,long elapsed,float threshold) {
        if(elapsed<0 || elapsed>900 || Math.abs(dx)<threshold || Math.abs(dx)<Math.abs(dy)*1.6f) return 0;
        return dx>0?1:-1;
    }
}
