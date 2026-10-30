package com.cortex.mobile;

import android.app.Activity;
import android.app.Dialog;
import android.content.Intent;
import android.content.ClipData;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Matrix;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.media.ExifInterface;
import android.net.Uri;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.util.Base64;
import android.view.Gravity;
import android.view.Window;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.ImageView;
import android.widget.Toast;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.io.File;
import java.nio.ByteBuffer;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.UUID;

/** Uses Android's picker grants; never enumerates unselected device files. */
final class AttachmentController {
    private static final int PHOTO=601, CAMERA=602, FILE=603;
    private final Activity activity; private final Runnable changed; private JSONObject item;
    AttachmentController(Activity activity,Runnable changed) { this.activity=activity; this.changed=changed; }
    boolean hasItem(){return item!=null;}
    String name(){return item==null?"":item.optString("name");}
    void clear(){item=null;changed.run();}
    JSONObject snapshot() throws Exception {return item==null?null:new JSONObject(item.toString());}
    void show() {
        boolean light=activity.getSharedPreferences("cortex",0).getBoolean("light_theme",false); int fg=light?0xff181a1f:0xfff2f2f3, bg=light?0xfff7f7f8:0xff202124, card=light?0xffe9eaed:0xff393a3d;float density=activity.getResources().getDisplayMetrics().density;
        Dialog dialog=new Dialog(activity); LinearLayout sheet=new LinearLayout(activity);sheet.setOrientation(LinearLayout.VERTICAL);sheet.setPadding((int)(16*density),(int)(20*density),(int)(16*density),(int)(28*density));GradientDrawable surface=new GradientDrawable();surface.setColor(bg);surface.setCornerRadii(new float[]{24*density,24*density,24*density,24*density,0,0,0,0});sheet.setBackground(surface);LinearLayout row=new LinearLayout(activity);row.setOrientation(LinearLayout.HORIZONTAL);sheet.addView(row);
        String[] titles={"拍摄","相册","文件"};int[] icons={android.R.drawable.ic_menu_camera,android.R.drawable.ic_menu_gallery,android.R.drawable.ic_menu_save};for(int i=0;i<titles.length;i++){final int pos=i;LinearLayout cardView=new LinearLayout(activity);cardView.setOrientation(LinearLayout.VERTICAL);cardView.setGravity(Gravity.CENTER);cardView.setPadding(0,(int)(16*density),0,(int)(16*density));GradientDrawable shape=new GradientDrawable();shape.setColor(card);shape.setCornerRadius(16*density);cardView.setBackground(shape);LinearLayout.LayoutParams lp=new LinearLayout.LayoutParams(0,(int)(105*density),1);if(i>0)lp.leftMargin=(int)(8*density);row.addView(cardView,lp);ImageView icon=new ImageView(activity);icon.setImageResource(icons[i]);icon.setColorFilter(fg);cardView.addView(icon,new LinearLayout.LayoutParams((int)(26*density),(int)(26*density)));TextView label=new TextView(activity);label.setText(titles[i]);label.setTextColor(fg);label.setTextSize(15);label.setGravity(Gravity.CENTER);LinearLayout.LayoutParams labelParams=new LinearLayout.LayoutParams(-1,-2);labelParams.topMargin=(int)(8*density);cardView.addView(label,labelParams);cardView.setOnClickListener(v->{dialog.dismiss();if(pos==0){if(activity.checkSelfPermission(android.Manifest.permission.CAMERA)!=android.content.pm.PackageManager.PERMISSION_GRANTED){activity.requestPermissions(new String[]{android.Manifest.permission.CAMERA},605);return;}launchCamera();return;}try{Intent intent=new Intent(Intent.ACTION_OPEN_DOCUMENT);intent.addCategory(Intent.CATEGORY_OPENABLE);intent.setType(pos==1?"image/*":"*/*");intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);activity.startActivityForResult(intent,pos==1?PHOTO:FILE);}catch(Exception e){Toast.makeText(activity,"无法打开选择器",Toast.LENGTH_LONG).show();}});}
        TextView note=new TextView(activity);note.setText("文件支持 UTF-8 文本，最多 15 KB；照片发送前会压缩。");note.setTextSize(12);note.setTextColor(light?0xff70747d:0xffaaabb0);note.setPadding(0,(int)(12*density),0,0);sheet.addView(note);sheet.setOnApplyWindowInsetsListener((v,insets)->{int bottom=android.os.Build.VERSION.SDK_INT>=30?insets.getInsets(android.view.WindowInsets.Type.navigationBars()).bottom:insets.getSystemWindowInsetBottom();v.setPadding((int)(16*density),(int)(20*density),(int)(16*density),(int)(20*density)+bottom);return insets;});dialog.setContentView(sheet);Window w=dialog.getWindow();if(w!=null){w.setBackgroundDrawableResource(android.R.color.transparent);w.setGravity(Gravity.BOTTOM);w.setWindowAnimations(R.style.CortexAttachmentAnimation);w.setLayout(-1,-2);}dialog.show();if(w!=null)w.setLayout(-1,-2);sheet.requestApplyInsets();
    }
    void cameraPermissionResult(int[] results){if(results.length>0 && results[0]==android.content.pm.PackageManager.PERMISSION_GRANTED)launchCamera();else Toast.makeText(activity,"未授予相机权限，可继续使用相册或文件。",Toast.LENGTH_LONG).show();}
    private void launchCamera(){try{Intent intent=new Intent(MediaStore.ACTION_IMAGE_CAPTURE);Uri target=createCapture();intent.putExtra(MediaStore.EXTRA_OUTPUT,target);intent.setClipData(ClipData.newRawUri("camera",target));intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION|Intent.FLAG_GRANT_WRITE_URI_PERMISSION);activity.startActivityForResult(intent,CAMERA);}catch(Exception e){cleanupCapture();Toast.makeText(activity,"无法打开相机",Toast.LENGTH_LONG).show();}}
    boolean result(int code,int result,Intent data) {
        if(code!=PHOTO&&code!=CAMERA&&code!=FILE)return false;
        if(result!=Activity.RESULT_OK){if(code==CAMERA)cleanupCapture();return true;}
        try {
            Uri uri=code==CAMERA?pendingCapture():(data==null?null:data.getData());if(uri==null||!"content".equals(uri.getScheme()))throw new Exception("未选择有效文件");String name=code==CAMERA?"拍摄照片.jpg":displayName(uri);byte[] bytes=read(uri,code==FILE?15000:16*1024*1024);
            if(code!=FILE){BitmapFactory.Options opt=new BitmapFactory.Options();opt.inJustDecodeBounds=true;BitmapFactory.decodeByteArray(bytes,0,bytes.length,opt);if(opt.outWidth<=0||opt.outHeight<=0||opt.outWidth>20000||opt.outHeight>20000)throw new Exception("图片尺寸无效");opt.inSampleSize=1;while(Math.max(opt.outWidth,opt.outHeight)/opt.inSampleSize>2000)opt.inSampleSize*=2;opt.inJustDecodeBounds=false;Bitmap bitmap=BitmapFactory.decodeByteArray(bytes,0,bytes.length,opt);if(bitmap==null)throw new Exception("无法读取图片");setImage(orient(bitmap,bytes),name);}else {String value=StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString();if(value.indexOf('\0')>=0)throw new Exception("仅支持 UTF-8 文本文件");item=new JSONObject().put("kind","text").put("name",name).put("content",value);changed.run();}
        } catch(Exception e){Toast.makeText(activity,"附件无法读取："+e.getMessage(),Toast.LENGTH_LONG).show();}finally{if(code==CAMERA)cleanupCapture();}return true;
    }
    private Uri createCapture() throws Exception {cleanupCapture();File dir=new File(activity.getCacheDir(),"captures");if(!dir.exists()&&!dir.mkdirs())throw new Exception("无法创建相机缓存");String name=UUID.randomUUID().toString().replace("-","")+".jpg";File target=new File(dir,name);if(!target.createNewFile())throw new Exception("无法创建相机缓存");activity.getSharedPreferences("cortex_capture",0).edit().putString("pending",name).apply();return new Uri.Builder().scheme("content").authority(activity.getPackageName()+".capture").appendPath(name).build();}
    private Uri pendingCapture(){String name=activity.getSharedPreferences("cortex_capture",0).getString("pending","");if(!name.matches("[a-f0-9]{32}\\.jpg"))return null;return new Uri.Builder().scheme("content").authority(activity.getPackageName()+".capture").appendPath(name).build();}
    private void cleanupCapture(){Uri uri=pendingCapture();activity.getSharedPreferences("cortex_capture",0).edit().remove("pending").apply();if(uri!=null){try{activity.revokeUriPermission(uri,Intent.FLAG_GRANT_READ_URI_PERMISSION|Intent.FLAG_GRANT_WRITE_URI_PERMISSION);}catch(Exception ignored){}try{activity.getContentResolver().delete(uri,null,null);}catch(Exception ignored){}}}
    private String displayName(Uri uri){String n="附件";try(Cursor c=activity.getContentResolver().query(uri,new String[]{OpenableColumns.DISPLAY_NAME},null,null,null)){if(c!=null&&c.moveToFirst()&&!c.isNull(0))n=c.getString(0);}catch(Exception ignored){}return n.replaceAll("[\\r\\n\\x00-\\x1f]","_").substring(0,Math.min(n.length(),128));}
    private byte[] read(Uri uri,int limit) throws Exception {try(InputStream in=activity.getContentResolver().openInputStream(uri);ByteArrayOutputStream out=new ByteArrayOutputStream()){if(in==null)throw new Exception("没有文件读取权限");byte[] b=new byte[8192];int n;while((n=in.read(b))!=-1){if(out.size()+n>limit)throw new Exception("文件过大");out.write(b,0,n);}return out.toByteArray();}}
    private Bitmap orient(Bitmap bitmap,byte[] bytes) { try { int o=new ExifInterface(new ByteArrayInputStream(bytes)).getAttributeInt(ExifInterface.TAG_ORIENTATION,ExifInterface.ORIENTATION_NORMAL); Matrix matrix=new Matrix();switch(o){case ExifInterface.ORIENTATION_FLIP_HORIZONTAL:matrix.setScale(-1,1);break;case ExifInterface.ORIENTATION_ROTATE_180:matrix.setRotate(180);break;case ExifInterface.ORIENTATION_FLIP_VERTICAL:matrix.setScale(1,-1);break;case ExifInterface.ORIENTATION_TRANSPOSE:matrix.setRotate(90);matrix.postScale(-1,1);break;case ExifInterface.ORIENTATION_ROTATE_90:matrix.setRotate(90);break;case ExifInterface.ORIENTATION_TRANSVERSE:matrix.setRotate(-90);matrix.postScale(-1,1);break;case ExifInterface.ORIENTATION_ROTATE_270:matrix.setRotate(-90);break;default:return bitmap;}return Bitmap.createBitmap(bitmap,0,0,bitmap.getWidth(),bitmap.getHeight(),matrix,true);}catch(Exception ignored){return bitmap;} }
    private void setImage(Bitmap source,String name) throws Exception {int max=Math.max(source.getWidth(),source.getHeight());Bitmap bitmap=max>1600?Bitmap.createScaledBitmap(source,Math.max(1,source.getWidth()*1600/max),Math.max(1,source.getHeight()*1600/max),true):source;ByteArrayOutputStream out=new ByteArrayOutputStream();bitmap.compress(Bitmap.CompressFormat.JPEG,75,out);if(out.size()>1024*1024)throw new Exception("图片过大，请选择较小的图片");String safeName=name.replaceAll("(?i)\\.(png|webp|jpeg|jpg|heic|heif)$","")+".jpg";item=new JSONObject().put("kind","image").put("name",safeName).put("mediaType","image/jpeg").put("dataUrl","data:image/jpeg;base64,"+Base64.encodeToString(out.toByteArray(),Base64.NO_WRAP));changed.run();}
    static JSONArray apiHistory(JSONArray history) throws Exception {JSONArray result=new JSONArray();for(int i=0;i<history.length();i++){JSONObject m=new JSONObject(history.getJSONObject(i).toString());JSONArray attachments=m.optJSONArray("attachments");m.remove("attachments");m.remove("messages_content");if(attachments!=null&&attachments.length()>0){JSONArray parts=new JSONArray();String text=m.optString("content","");if(!text.isEmpty())parts.put(new JSONObject().put("type","text").put("text",text));for(int j=0;j<attachments.length();j++)parts.put(new JSONObject().put("type","image_url").put("image_url",new JSONObject().put("url",attachments.getJSONObject(j).getString("dataUrl"))));m.put("content",parts);}result.put(m);}return result;}
}
