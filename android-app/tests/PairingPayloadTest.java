package com.cortex.mobile;

import org.json.JSONArray;
import org.json.JSONObject;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;

public final class PairingPayloadTest {
    private static void invalid(JSONObject v) throws Exception {try{PairingPayload.parse(v.toString());throw new AssertionError("accepted invalid QR");}catch(IllegalArgumentException expected){}}
    public static void main(String[] args) throws Exception {
        String fp="AA:".repeat(31)+"AA",token="A".repeat(43);
        JSONObject valid=new JSONObject().put("v",1).put("url","https://192.168.1.10:3456").put("fingerprint",fp).put("token",token);
        PairingPayload pair=PairingPayload.parse(valid.toString());if(!pair.token.equals(token))throw new AssertionError("token changed");
        invalid(new JSONObject(valid.toString()).put("url","http://192.168.1.10:3456"));
        invalid(new JSONObject(valid.toString()).put("url","https://user@192.168.1.10:3456"));
        invalid(new JSONObject(valid.toString()).put("url","https://192.168.1.10:3456/other"));
        for(String address:new String[]{"https://example.com:3456","https://node-1.example.net:443","https://203.0.113.9:12345"}) {
            if(!PairingPayload.parse(new JSONObject(valid.toString()).put("url",address).toString()).url.equals(address))throw new AssertionError("address changed");
        }
        invalid(new JSONObject(valid.toString()).put("url","https://999.168.1.10:3456"));
        invalid(new JSONObject(valid.toString()).put("url","https://01.168.1.10:3456"));
        invalid(new JSONObject(valid.toString()).put("url","https://example.com:3456?token=test"));
        invalid(new JSONObject(valid.toString()).put("url","https://example.com:3456#fragment"));
        invalid(new JSONObject(valid.toString()).put("url","https://example.com:65536"));
        invalid(new JSONObject(valid.toString()).put("url","https://[::1]:3456"));
        invalid(new JSONObject(valid.toString()).put("url","https://192.168.1.10:0"));
        invalid(new JSONObject(valid.toString()).put("fingerprint","AB"));
        invalid(new JSONObject(valid.toString()).put("token","A"));
        invalid(new JSONObject(valid.toString()).put("v",2));
        invalid(new JSONObject(valid.toString()).put("extra",true));
        try{PairingPayload.parse(valid.toString()+" trailing");throw new AssertionError("trailing input accepted");}catch(IllegalArgumentException expected){}
        try{PairingPayload.parse(valid.toString().replace("\"v\":1","\"v\":1,\"v\":1"));throw new AssertionError("duplicate field accepted");}catch(IllegalArgumentException | org.json.JSONException expected){}
        JSONObject generated=new JSONObject(Files.readString(Path.of(args[0])));int size=generated.getInt("size"),scale=4,margin=4,side=(size+margin*2)*scale;byte[] pixels=new byte[side*side];Arrays.fill(pixels,(byte)255);JSONArray modules=generated.getJSONArray("modules");
        for(int y=0;y<size;y++)for(int x=0;x<size;x++)if(modules.getJSONArray(y).getBoolean(x))for(int yy=0;yy<scale;yy++)for(int xx=0;xx<scale;xx++)pixels[((y+margin)*scale+yy)*side+(x+margin)*scale+xx]=0;
        for(int turn=0;turn<4;turn++){String decoded=QrLuminanceDecoder.decode(pixels,side,side);if(decoded==null || !PairingPayload.parse(decoded).token.equals(token))throw new AssertionError("desktop QR not decoded at rotation "+turn);byte[] next=new byte[pixels.length];for(int y=0;y<side;y++)for(int x=0;x<side;x++)next[x*side+side-1-y]=pixels[y*side+x];pixels=next;}
        System.out.println("Pairing validation and desktop QR decoding passed");
    }
}
