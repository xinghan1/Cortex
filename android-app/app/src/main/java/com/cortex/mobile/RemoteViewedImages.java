package com.cortex.mobile;

import android.app.Activity;
import android.app.Dialog;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.util.Base64;
import android.util.LruCache;
import android.view.Gravity;
import android.view.View;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;
import java.util.concurrent.Executor;
import org.json.JSONObject;

/** Loads only image references backed by a verified desktop view receipt. */
final class RemoteViewedImages {
    interface Loader { JSONObject load(String id,String sessionId) throws Exception; }
    private final Activity activity; private final Executor worker; private final Loader loader;
    private final LruCache<String,Bitmap> cache=new LruCache<>(4);
    RemoteViewedImages(Activity activity,Executor worker,Loader loader){this.activity=activity;this.worker=worker;this.loader=loader;}
    View create(String id,String session,String name,int color){
        float d=activity.getResources().getDisplayMetrics().density;LinearLayout box=new LinearLayout(activity);box.setOrientation(LinearLayout.VERTICAL);box.setPadding(0,(int)(8*d),0,(int)(8*d));
        TextView label=new TextView(activity);label.setText("已查看图片 · "+name);label.setTextColor(color);label.setTextSize(13);box.addView(label);
        ImageView thumbnail=new ImageView(activity);thumbnail.setScaleType(ImageView.ScaleType.FIT_CENTER);thumbnail.setContentDescription("查看图片 "+name);box.addView(thumbnail,new LinearLayout.LayoutParams((int)(160*d),(int)(120*d)));
        String key=session+":"+id;Bitmap cached=cache.get(key);if(cached!=null)thumbnail.setImageBitmap(cached);else {label.setText("正在加载图片…");worker.execute(()->{try{JSONObject data=loader.load(id,session);String raw=data.getString("dataUrl");int comma=raw.indexOf(',');if(comma<0||!raw.startsWith("data:image/")||raw.length()>2800000)throw new Exception("图片格式无效");byte[] bytes=Base64.decode(raw.substring(comma+1),Base64.DEFAULT);BitmapFactory.Options opts=new BitmapFactory.Options();opts.inJustDecodeBounds=true;BitmapFactory.decodeByteArray(bytes,0,bytes.length,opts);if(opts.outWidth<=0||opts.outHeight<=0)throw new Exception("图片无法解码");opts.inSampleSize=1;while(Math.max(opts.outWidth,opts.outHeight)/opts.inSampleSize>1600)opts.inSampleSize*=2;opts.inJustDecodeBounds=false;Bitmap image=BitmapFactory.decodeByteArray(bytes,0,bytes.length,opts);if(image==null)throw new Exception("图片无法解码");cache.put(key,image);activity.runOnUiThread(()->{if(!activity.isFinishing()){thumbnail.setImageBitmap(image);label.setText("已查看图片 · "+name);}});}catch(Exception ex){activity.runOnUiThread(()->label.setText("图片不可用"));}});}
        thumbnail.setOnClickListener(v->{Bitmap image=cache.get(key);if(image==null)return;Dialog dialog=new Dialog(activity);ImageView full=new ImageView(activity);full.setImageBitmap(image);full.setScaleType(ImageView.ScaleType.FIT_CENTER);full.setOnClickListener(x->dialog.dismiss());dialog.setContentView(full);dialog.show();if(dialog.getWindow()!=null)dialog.getWindow().setLayout(-1,-1);});return box;
    }
}
