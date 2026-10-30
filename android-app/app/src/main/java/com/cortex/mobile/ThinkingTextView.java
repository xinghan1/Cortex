package com.cortex.mobile;

import android.animation.ValueAnimator;
import android.content.Context;
import android.graphics.LinearGradient;
import android.graphics.Matrix;
import android.graphics.Shader;
import android.view.View;
import android.view.animation.LinearInterpolator;
import android.widget.TextView;

/** Shimmer only while an actual task is running; releases animation off screen. */
final class ThinkingTextView extends TextView {
    private ValueAnimator animator;
    private LinearGradient gradient;
    private final Matrix matrix = new Matrix();
    private boolean active;
    private float position;
    private int gradientWidth, gradientColor;
    ThinkingTextView(Context context) { super(context); }
    void setActive(boolean value) { if (active == value) return; active = value; syncAnimation(); invalidate(); }
    private void syncAnimation() {
        boolean shouldRun = active && isAttachedToWindow() && getVisibility() == View.VISIBLE && ValueAnimator.areAnimatorsEnabled();
        if (!shouldRun) {
            if (animator != null) { animator.cancel(); animator = null; }
            getPaint().setShader(null); gradient = null; return;
        }
        if (animator != null) return;
        animator = ValueAnimator.ofFloat(-1f, 2f);
        animator.setDuration(1800); animator.setRepeatCount(ValueAnimator.INFINITE);
        animator.setInterpolator(new LinearInterpolator());
        animator.addUpdateListener(a -> { position = (Float) a.getAnimatedValue(); invalidate(); });
        animator.start();
    }
    @Override protected void onDraw(android.graphics.Canvas canvas) {
        if (animator != null && getWidth() > 0) {
            float width = Math.max(1, getWidth()); int base = getCurrentTextColor();
            if (gradient == null || gradientWidth != getWidth() || gradientColor != base) {
                int highlight = android.graphics.Color.luminance(base) < .25f ? 0xff324f80 : 0xffd2e4ff;
                gradient = new LinearGradient(0, 0, width, 0, new int[]{base, highlight, base}, new float[]{0f, .5f, 1f}, Shader.TileMode.CLAMP);
                gradientWidth = getWidth(); gradientColor = base;
            }
            matrix.setTranslate((position - 0.5f) * width, 0); gradient.setLocalMatrix(matrix); getPaint().setShader(gradient);
        } else getPaint().setShader(null);
        super.onDraw(canvas);
    }
    @Override protected void onAttachedToWindow() { super.onAttachedToWindow(); syncAnimation(); }
    @Override protected void onDetachedFromWindow() { if (animator != null) { animator.cancel(); animator = null; } getPaint().setShader(null); super.onDetachedFromWindow(); }
    @Override protected void onVisibilityChanged(View view, int visibility) { super.onVisibilityChanged(view, visibility); syncAnimation(); }
}
