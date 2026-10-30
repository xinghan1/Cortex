package com.cortex.mobile;

import android.graphics.Typeface;
import android.text.SpannableStringBuilder;
import android.text.Spanned;
import android.text.style.BackgroundColorSpan;
import android.text.style.ForegroundColorSpan;
import android.text.style.QuoteSpan;
import android.text.style.RelativeSizeSpan;
import android.text.style.StyleSpan;
import android.text.style.TypefaceSpan;
import android.text.style.URLSpan;
import android.text.method.LinkMovementMethod;
import android.widget.TextView;
import java.net.URI;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Renders plain Markdown as native Android spans; raw HTML is never executed. */
final class MarkdownRenderer {
    private static final int FLAGS=Spanned.SPAN_EXCLUSIVE_EXCLUSIVE;
    private static final Pattern HEADING=Pattern.compile("^(#{1,6})[ \\t]+(.*)$");
    private static final Pattern LIST=Pattern.compile("^( {0,8})([-+*]|[0-9]{1,4}[.)])[ \\t]+(.*)$");
    private final int codeBackground, quoteColor, stringColor, numberColor, keywordColor, commentColor, keyColor;
    private int highlightChars=SyntaxHighlighter.MAX_CHARS, highlightTokens=SyntaxHighlighter.MAX_TOKENS;
    private final SpannableStringBuilder out=new SpannableStringBuilder();
    private MarkdownRenderer(boolean light) { codeBackground=light?0xffe9ebef:0xff272a30; quoteColor=light?0xff7d8ca3:0xff8599b5; stringColor=light?0xff176c4c:0xffa5d6a7; numberColor=light?0xffa04b16:0xffffc078; keywordColor=light?0xff6038ad:0xffc4a5ff; commentColor=light?0xff697786:0xff9aa9b8; keyColor=light?0xff1759a3:0xff91c7ff; }

    static void apply(TextView view,String source,boolean light) {
        MarkdownRenderer renderer=new MarkdownRenderer(light);
        view.setText(renderer.render(source==null?"":source));
        view.setTextIsSelectable(true);
        view.setMovementMethod(LinkMovementMethod.getInstance());
    }
    static void applyJsonCode(TextView view,String source,boolean light) {
        String value=source==null?"":source;SpannableStringBuilder result=new SpannableStringBuilder(value);MarkdownRenderer colors=new MarkdownRenderer(light);
        for(SyntaxHighlighter.Token token:SyntaxHighlighter.tokenize(value,"json"))result.setSpan(new ForegroundColorSpan(colors.colorFor(token.kind)),token.start,token.end,FLAGS);
        view.setText(result);
    }
    private int colorFor(String kind) { switch(kind){case "string":return stringColor;case "number":return numberColor;case "keyword":return keywordColor;case "comment":return commentColor;default:return keyColor;} }
    private void span(Object style,int start,int end) { if(end>start) out.setSpan(style,start,end,FLAGS); }
    private CharSequence render(String source) {
        String[] lines=source.replace("\r\n","\n").replace('\r','\n').split("\n",-1);
        boolean fenced=false; String fence="",language=""; int codeStart=0;
        for(int i=0;i<lines.length;i++) {
            String line=lines[i],trim=line.trim();
            if(trim.startsWith("```") || trim.startsWith("~~~")) {
                String mark=trim.substring(0,3);
                if(!fenced) { fenced=true; fence=mark; String info=trim.substring(3).trim();language=info.isEmpty()?"":info.split("\\s+",2)[0]; if(!language.isEmpty()){int label=out.length();out.append(language).append('\n');span(new ForegroundColorSpan(commentColor),label,out.length());span(new RelativeSizeSpan(.8f),label,out.length());} codeStart=out.length(); continue; }
                if(mark.equals(fence)) { finishCode(codeStart,language); fenced=false; continue; }
            }
            if(fenced) { out.append(line); if(i<lines.length-1) out.append('\n'); continue; }
            int start=out.length(); Matcher heading=HEADING.matcher(line), list=LIST.matcher(line);
            if(heading.matches()) {
                inline(heading.group(2)); int end=out.length(); span(new StyleSpan(Typeface.BOLD),start,end);
                span(new RelativeSizeSpan(heading.group(1).length()==1?1.45f:heading.group(1).length()==2?1.30f:1.15f),start,end);
            } else if(trim.startsWith(">")) {
                String quote=trim.substring(1); if(quote.startsWith(" ")) quote=quote.substring(1); inline(quote);
                if(i<lines.length-1) out.append('\n'); span(new QuoteSpan(quoteColor),start,out.length()); continue;
            } else if(list.matches()) {
                out.append(list.group(1)); String marker=list.group(2); out.append(marker.length()==1?"• ":marker+" "); inline(list.group(3));
            } else inline(line);
            if(i<lines.length-1) out.append('\n');
        }
        if(fenced) finishCode(codeStart,language);
        return out;
    }
    private void finishCode(int start,String language) {
        int end=out.length();span(new TypefaceSpan("monospace"),start,end);span(new BackgroundColorSpan(codeBackground),start,end);
        int count=Math.min(highlightChars,end-start);if(count<=0||highlightTokens<=0)return;
        String code=out.subSequence(start,start+count).toString();highlightChars-=count;
        for(SyntaxHighlighter.Token token:SyntaxHighlighter.tokenize(code,language)) {if(highlightTokens--<=0)break;
            span(new ForegroundColorSpan(colorFor(token.kind)),start+token.start,start+token.end);
        }
    }
    private void inline(String text) { inline(text,0); }
    private void inline(String text,int depth) {
        if(depth>8) { out.append(text); return; }
        boolean noMoreLinks=false;
        for(int i=0;i<text.length();) {
            char ch=text.charAt(i);
            if(ch=='\\' && i+1<text.length()) { out.append(text.charAt(i+1)); i+=2; continue; }
            if(ch=='`') { int end=text.indexOf('`',i+1); if(end>i+1) { int start=out.length();out.append(text.substring(i+1,end));span(new TypefaceSpan("monospace"),start,out.length());span(new BackgroundColorSpan(codeBackground),start,out.length());span(new ForegroundColorSpan(keyColor),start,out.length());i=end+1;continue; } }
            if(ch=='[' && !noMoreLinks) { int labelEnd=text.indexOf("](",i+1), urlEnd=labelEnd<0?-1:text.indexOf(')',labelEnd+2); if(labelEnd<0 || urlEnd<0) noMoreLinks=true; if(labelEnd>i+1 && urlEnd>labelEnd+2) { String url=text.substring(labelEnd+2,urlEnd); if(safeUrl(url)) { int start=out.length();inline(text.substring(i+1,labelEnd),depth+1);span(new URLSpan(url),start,out.length());i=urlEnd+1;continue; } } }
            String delimiter=null; int style=0;
            if(text.startsWith("**",i)||text.startsWith("__",i)) { delimiter=text.substring(i,i+2);style=Typeface.BOLD; }
            else if(ch=='*'||ch=='_') { delimiter=String.valueOf(ch);style=Typeface.ITALIC; }
            if(delimiter!=null) { int end=text.indexOf(delimiter,i+delimiter.length()); if(end>i+delimiter.length()) { int start=out.length();inline(text.substring(i+delimiter.length(),end),depth+1);span(new StyleSpan(style),start,out.length());i=end+delimiter.length();continue; } }
            out.append(ch); i++;
        }
    }
    private static boolean safeUrl(String value) {
        try { URI uri=new URI(value); String scheme=uri.getScheme(); return scheme!=null && (scheme.equalsIgnoreCase("https")||scheme.equalsIgnoreCase("http")) && uri.getHost()!=null && uri.getUserInfo()==null; }
        catch(Exception ignored) { return false; }
    }
}
