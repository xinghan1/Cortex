package com.cortex.mobile;
/** Recognizes image containers without decoding or modifying their bytes. */
final class ImagePayload {
    private ImagePayload() {}
    static String mediaType(byte[] b) {
        if(b==null)return "";
        if(b.length>=3&&(b[0]&255)==255&&(b[1]&255)==216&&(b[2]&255)==255)return "image/jpeg";
        if(b.length>=8&&(b[0]&255)==137&&b[1]==80&&b[2]==78&&b[3]==71&&b[4]==13&&b[5]==10&&b[6]==26&&b[7]==10)return "image/png";
        if(b.length>=12&&b[0]==82&&b[1]==73&&b[2]==70&&b[3]==70&&b[8]==87&&b[9]==69&&b[10]==66&&b[11]==80)return "image/webp";
        return "";
    }
}
