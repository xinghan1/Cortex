package com.cortex.mobile;

import android.content.Context;
import android.graphics.Color;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.LayerDrawable;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.ArrayAdapter;
import android.widget.Spinner;
import android.widget.TextView;
import java.util.Arrays;
import java.util.List;

/** Shared styling for model and settings dropdowns in both app themes. */
final class RoundedSpinner {
    private RoundedSpinner() {}
    private static int dp(Context c,float value) { return (int)(value*c.getResources().getDisplayMetrics().density+.5f); }
    private static GradientDrawable shape(Context c,boolean light,boolean popup) {
        GradientDrawable d=new GradientDrawable();
        d.setColor(light?(popup?0xfffafafc:0xffe9eaed):(popup?0xff2c2e33:0xff292b30));
        d.setCornerRadius(dp(c,14));
        d.setStroke(dp(c,1),light?0xffd2d4d9:0xff484b52);
        return d;
    }
    static void style(Spinner spinner,boolean light) {
        Context c=spinner.getContext();
        Drawable arrow=c.getDrawable(R.drawable.spinner_chevron).mutate();
        arrow.setTint(light?0xff62656d:0xffb8bcc5);
        LayerDrawable layers=new LayerDrawable(new Drawable[]{shape(c,light,false),arrow});
        layers.setLayerSize(1,dp(c,16),dp(c,16));
        layers.setLayerGravity(1,Gravity.END|Gravity.CENTER_VERTICAL);
        layers.setLayerInset(1,0,0,dp(c,14),0);
        spinner.setBackground(layers);
        spinner.setPadding(dp(c,14),0,dp(c,40),0);
        spinner.setPopupBackgroundDrawable(shape(c,light,true));
        spinner.setDropDownVerticalOffset(dp(c,4));
    }
    static ArrayAdapter<String> adapter(Context c,String[] items,boolean light) {return adapter(c,Arrays.asList(items),light);}
    static ArrayAdapter<String> adapter(Context c,List<String> items,boolean light) {
        return new ArrayAdapter<String>(c,android.R.layout.simple_spinner_item,items) {
            private View item(int position,View old,boolean dropdown) {
                TextView text=old instanceof TextView?(TextView)old:new TextView(c);
                text.setText(getItem(position));text.setTextColor(light?0xff20242c:0xffedf0f5);text.setTextSize(15);
                text.setGravity(Gravity.CENTER_VERTICAL);text.setSingleLine(true);
                text.setEllipsize(android.text.TextUtils.TruncateAt.END);
                text.setMinHeight(dp(c,dropdown?48:44));
                text.setPadding(dropdown?dp(c,16):0,0,dropdown?dp(c,16):0,0);
                text.setBackgroundColor(Color.TRANSPARENT);
                return text;
            }
            @Override public View getView(int position,View old,ViewGroup parent) {return item(position,old,false);}
            @Override public View getDropDownView(int position,View old,ViewGroup parent) {return item(position,old,true);}
        };
    }
}
