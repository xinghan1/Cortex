package com.cortex.mobile;
public final class ImagePayloadTest {
 public static void main(String[] args){
  byte[][] data={{(byte)255,(byte)216,(byte)255,1},{(byte)137,80,78,71,13,10,26,10},{82,73,70,70,0,0,0,0,87,69,66,80},{1,2,3}};
  String[] want={"image/jpeg","image/png","image/webp",""};
  for(int i=0;i<data.length;i++){byte[] before=data[i].clone();if(!want[i].equals(ImagePayload.mediaType(data[i]))||!java.util.Arrays.equals(before,data[i]))throw new AssertionError("image format/bytes");}
  System.out.println("Image media detection preserves bytes");
 }
}
