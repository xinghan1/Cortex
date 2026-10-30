package com.cortex.mobile;

import com.google.zxing.BinaryBitmap;
import com.google.zxing.MultiFormatReader;
import com.google.zxing.PlanarYUVLuminanceSource;
import com.google.zxing.common.HybridBinarizer;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import org.json.JSONArray;
import org.json.JSONObject;

/** Decodes a synthetic desktop QR with the same ZXing reader used on Android. */
public final class PairingQrDecodeTest {
    public static void main(String[] args) throws Exception {
        JSONObject matrix=new JSONObject(new String(System.in.readAllBytes(),StandardCharsets.UTF_8));
        int size=matrix.getInt("size"),scale=4,quiet=4,width=(size+quiet*2)*scale;JSONArray rows=matrix.getJSONArray("modules");
        byte[] pixels=new byte[width*width];Arrays.fill(pixels,(byte)255);
        for(int y=0;y<size;y++)for(int x=0;x<size;x++)if(rows.getJSONArray(y).getBoolean(x))for(int dy=0;dy<scale;dy++)for(int dx=0;dx<scale;dx++)pixels[((y+quiet)*scale+dy)*width+(x+quiet)*scale+dx]=0;
        String decoded=new MultiFormatReader().decode(new BinaryBitmap(new HybridBinarizer(new PlanarYUVLuminanceSource(pixels,width,width,0,0,width,width,false)))).getText();
        JSONObject value=new JSONObject(decoded);
        if(value.length()!=4 || value.getInt("v")!=1 || !"https://192.168.10.2:51234".equals(value.getString("url")) || !value.getString("token").equals("a".repeat(43)) || !value.getString("fingerprint").equals(String.join(":",java.util.Collections.nCopies(32,"AB")))) throw new AssertionError("pairing payload mismatch");
        System.out.println("Desktop QR decoded successfully by Android ZXing");
    }
}
