package com.cortex.mobile;

/** JVM regression test for strict JSON detection and its processing limits. */
public final class JsonValidityTest {
    public static void main(String[] args) {
        for(String value:new String[]{"{}","[true,null,12.4e-3]","{\"nested\":[{\"escaped\":\"\\u4e2d\\n\"}]}"})
            if(!JsonValidity.isContainer(value))throw new AssertionError("valid JSON rejected: "+value);
        for(String value:new String[]{"{oops: 1}","{\"a\":1,}","{\"a\":01}","{\"a\":1} trailing","[1,]","42","{\"x\":\"bad\\q\"}"})
            if(JsonValidity.isContainer(value))throw new AssertionError("invalid JSON accepted: "+value);
        if(JsonValidity.isContainer("[".repeat(70)+"]".repeat(70))||JsonValidity.isContainer("["+" ".repeat(SyntaxHighlighter.MAX_CHARS)+"]"))
            throw new AssertionError("JSON bound not enforced");
        System.out.println("Strict JSON validation passed");
    }
}
