package com.cortex.mobile;

import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.provider.DocumentsContract;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

/** File operations are confined to the folder the user selected in Android's picker. */
final class FolderTools {
    private final Context context; private final Uri tree;
    FolderTools(Context context, String uri) { this.context=context; this.tree=uri.isEmpty()?null:Uri.parse(uri); }
    private Uri root() throws Exception { if(tree==null) throw new Exception("用户尚未授权文件夹，请先在设置中选择文件夹"); return DocumentsContract.buildDocumentUriUsingTree(tree,DocumentsContract.getTreeDocumentId(tree)); }
    private String[] parts(String path) throws Exception {
        if(path==null||path.isEmpty()||path.equals(".")) return new String[0];
        if(path.startsWith("/")||path.contains("\\")||path.indexOf('\0')>=0) throw new Exception("路径必须位于授权文件夹内");
        String[] parts=path.split("/",-1); for(String s:parts) if(s.isEmpty()||s.equals(".")||s.equals("..")) throw new Exception("无效路径"); return parts;
    }
    private Uri child(Uri dir,String name) throws Exception {
        Uri children=DocumentsContract.buildChildDocumentsUriUsingTree(tree,DocumentsContract.getDocumentId(dir));
        try(Cursor c=context.getContentResolver().query(children,new String[]{DocumentsContract.Document.COLUMN_DOCUMENT_ID,DocumentsContract.Document.COLUMN_DISPLAY_NAME},null,null,null)) {
            if(c==null) throw new Exception("无法访问文件夹"); while(c.moveToNext()) if(name.equals(c.getString(1))) return DocumentsContract.buildDocumentUriUsingTree(tree,c.getString(0));
        } return null;
    }
    private Uri resolve(String[] names,int limit) throws Exception { Uri current=root(); for(int i=0;i<limit;i++) { current=child(current,names[i]); if(current==null) throw new Exception("文件或文件夹不存在"); } return current; }
    String call(String name,JSONObject args) throws Exception {
        String[] path=parts(args.optString("path",""));
        if(name.equals("list_files")) { Uri dir=resolve(path,path.length); Uri list=DocumentsContract.buildChildDocumentsUriUsingTree(tree,DocumentsContract.getDocumentId(dir)); JSONArray rows=new JSONArray();
            try(Cursor c=context.getContentResolver().query(list,new String[]{DocumentsContract.Document.COLUMN_DISPLAY_NAME,DocumentsContract.Document.COLUMN_MIME_TYPE},null,null,null)) { if(c==null) throw new Exception("无法列出文件"); while(c.moveToNext()&&rows.length()<500) rows.put(new JSONObject().put("name",c.getString(0)).put("type",DocumentsContract.Document.MIME_TYPE_DIR.equals(c.getString(1))?"directory":"file")); } return new JSONObject().put("entries",rows).toString(); }
        if(path.length==0) throw new Exception("请指定文件路径");
        if(name.equals("read_file")) { Uri file=resolve(path,path.length); try(InputStream in=context.getContentResolver().openInputStream(file); ByteArrayOutputStream out=new ByteArrayOutputStream()) { if(in==null) throw new Exception("无法打开文件"); byte[] buf=new byte[8192]; int n; while((n=in.read(buf))!=-1) { if(out.size()+n>1024*1024) throw new Exception("文件超过 1 MiB 限制"); out.write(buf,0,n); } return new JSONObject().put("content",out.toString("UTF-8")).toString(); } }
        if(name.equals("write_file")) { String value=args.getString("content"); byte[] bytes=value.getBytes(StandardCharsets.UTF_8); if(bytes.length>1024*1024) throw new Exception("内容超过 1 MiB 限制"); Uri parent=resolve(path,path.length-1); Uri file=child(parent,path[path.length-1]); if(file==null) file=DocumentsContract.createDocument(context.getContentResolver(),parent,"text/plain",path[path.length-1]); if(file==null) throw new Exception("无法创建文件"); try(OutputStream out=context.getContentResolver().openOutputStream(file,"wt")) { if(out==null) throw new Exception("无法打开文件写入"); out.write(bytes); } return new JSONObject().put("written",true).toString(); }
        throw new Exception("不支持的工具");
    }
    static JSONArray definitions() throws Exception { JSONArray tools=new JSONArray(); for(String name:new String[]{"list_files","read_file","write_file"}) { JSONObject properties=new JSONObject().put("path",new JSONObject().put("type","string").put("description","相对于用户授权文件夹的路径；列出根目录可用空字符串")); if(name.equals("write_file")) properties.put("content",new JSONObject().put("type","string")); JSONArray required=new JSONArray().put("path"); if(name.equals("write_file")) required.put("content"); JSONObject function=new JSONObject().put("name",name).put("description",name.equals("list_files")?"列出授权文件夹内的文件":name.equals("read_file")?"读取授权文件夹内的文本文件":"写入授权文件夹内的文本文件，覆盖同名文件").put("parameters",new JSONObject().put("type","object").put("properties",properties).put("required",required)); tools.put(new JSONObject().put("type","function").put("function",function)); } return tools; }
}
