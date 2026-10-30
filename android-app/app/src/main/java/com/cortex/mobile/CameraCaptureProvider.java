package com.cortex.mobile;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;
import java.io.File;
import java.io.FileNotFoundException;
import java.io.IOException;

/** A non-exported provider grants the camera access to one temporary capture only. */
public final class CameraCaptureProvider extends ContentProvider {
    @Override public boolean onCreate() { return true; }
    private File file(Uri uri) throws FileNotFoundException {
        if (uri == null || !"content".equals(uri.getScheme()) || !(getContext().getPackageName()+".capture").equals(uri.getAuthority()) || uri.getPathSegments().size()!=1 || !uri.getLastPathSegment().matches("[a-f0-9]{32}\\.jpg")) throw new FileNotFoundException("Invalid capture URI");
        File dir=new File(getContext().getCacheDir(),"captures");
        try { File target=new File(dir,uri.getLastPathSegment()); if(!target.getCanonicalFile().getParentFile().equals(dir.getCanonicalFile())) throw new FileNotFoundException("Invalid capture path"); return target; }
        catch(IOException e){ throw new FileNotFoundException("Invalid capture path"); }
    }
    @Override public ParcelFileDescriptor openFile(Uri uri,String mode) throws FileNotFoundException { return ParcelFileDescriptor.open(file(uri),ParcelFileDescriptor.parseMode(mode)); }
    @Override public String getType(Uri uri) { return "image/jpeg"; }
    @Override public Cursor query(Uri uri,String[] projection,String selection,String[] args,String sort) { String[] columns=projection==null?new String[]{OpenableColumns.DISPLAY_NAME,OpenableColumns.SIZE}:projection; MatrixCursor c=new MatrixCursor(columns); Object[] values=new Object[columns.length];try{File f=file(uri);for(int i=0;i<columns.length;i++)values[i]=OpenableColumns.DISPLAY_NAME.equals(columns[i])?f.getName():OpenableColumns.SIZE.equals(columns[i])?f.length():null;}catch(FileNotFoundException ignored){}c.addRow(values);return c; }
    @Override public int delete(Uri uri,String selection,String[] args) { try{return file(uri).delete()?1:0;}catch(FileNotFoundException e){return 0;} }
    @Override public Uri insert(Uri uri,ContentValues values) { throw new UnsupportedOperationException(); }
    @Override public int update(Uri uri,ContentValues values,String selection,String[] args) { throw new UnsupportedOperationException(); }
}
