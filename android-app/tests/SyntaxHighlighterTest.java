package com.cortex.mobile;

import java.util.List;

public final class SyntaxHighlighterTest {
    private static void expect(List<SyntaxHighlighter.Token> tokens,String source,String text,String kind) {
        for(SyntaxHighlighter.Token t:tokens) if(t.kind.equals(kind)&&source.substring(t.start,t.end).equals(text)) return;
        throw new AssertionError("missing "+kind+": "+text);
    }
    public static void main(String[] args) {
        String json="{\"name\": \"Cortex\", \"count\": 42, \"ok\": true}";
        List<SyntaxHighlighter.Token> a=SyntaxHighlighter.tokenize(json,"json");expect(a,json,"\"name\"","key");expect(a,json,"\"Cortex\"","string");expect(a,json,"42","number");expect(a,json,"true","keyword");
        String js="const x = 'ok'; // note";List<SyntaxHighlighter.Token> b=SyntaxHighlighter.tokenize(js,"javascript");expect(b,js,"const","keyword");expect(b,js,"'ok'","string");expect(b,js,"// note","comment");
        String html="<!-- hi --><div class=\"x\">";List<SyntaxHighlighter.Token> c=SyntaxHighlighter.tokenize(html,"html");expect(c,html,"<!-- hi -->","comment");expect(c,html,"<div","keyword");
        if(!SyntaxHighlighter.tokenize(js,"unrecognized").isEmpty())throw new AssertionError("unknown language must remain plain");
        String huge="const ".repeat(30000);List<SyntaxHighlighter.Token> capped=SyntaxHighlighter.tokenize(huge,"js");if(capped.size()>SyntaxHighlighter.MAX_TOKENS||capped.get(capped.size()-1).end>SyntaxHighlighter.MAX_CHARS)throw new AssertionError("limit not enforced");
        System.out.println("Syntax highlighting passed");
    }
}
