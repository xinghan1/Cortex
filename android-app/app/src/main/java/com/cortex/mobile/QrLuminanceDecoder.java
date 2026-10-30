package com.cortex.mobile;

import com.google.zxing.*;
import com.google.zxing.common.HybridBinarizer;
import java.util.Collections;
import java.util.EnumMap;

final class QrLuminanceDecoder {
    private QrLuminanceDecoder() {}
    static String decode(byte[] data,int width,int height){EnumMap<DecodeHintType,Object> hints=new EnumMap<>(DecodeHintType.class);hints.put(DecodeHintType.POSSIBLE_FORMATS,Collections.singletonList(BarcodeFormat.QR_CODE));hints.put(DecodeHintType.TRY_HARDER,Boolean.TRUE);for(int turn=0;turn<4;turn++){try{return new MultiFormatReader().decode(new BinaryBitmap(new HybridBinarizer(new PlanarYUVLuminanceSource(data,width,height,0,0,width,height,false))),hints).getText();}catch(NotFoundException ignored){}byte[] rotated=new byte[data.length];for(int y=0;y<height;y++)for(int x=0;x<width;x++)rotated[x*height+(height-1-y)]=data[y*width+x];data=rotated;int tmp=width;width=height;height=tmp;}return null;}
}
