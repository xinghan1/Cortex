package com.cortex.mobile;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/** A bounded lexer for display only. It never executes the code. */
final class SyntaxHighlighter {
    static final int MAX_CHARS=50000, MAX_TOKENS=4000;
    static final class Token { final int start,end; final String kind; Token(int start,int end,String kind){this.start=start;this.end=end;this.kind=kind;} }
    private static final Set<String> KEYWORDS=new HashSet<>(Arrays.asList(
            "if","else","for","while","do","switch","case","break","continue","return","throw","try","catch","finally","new","this","class","interface","extends","implements","public","private","protected","static","final","void","int","long","float","double","boolean","var","let","const","function","async","await","export","import","from","default","yield","typeof","instanceof","in","of","def","lambda","elif","except","raise","pass","with","as","and","or","not","is","None","True","False","true","false","null","undefined","SELECT","FROM","WHERE","JOIN","INSERT","UPDATE","DELETE","CREATE","TABLE","VALUES","AND","OR","NULL"));
    private static final Set<String> LANGUAGES=new HashSet<>(Arrays.asList("json","jsonc","javascript","js","jsx","typescript","ts","tsx","java","kotlin","kt","python","py","bash","sh","shell","powershell","ps1","css","scss","html","xml","svg","sql","c","cpp","c++","csharp","cs","go","rust","rs","ruby","rb"));
    static List<Token> tokenize(String input,String language) {
        ArrayList<Token> result=new ArrayList<>(); if(input==null||language==null)return result;
        String lang=language.trim().toLowerCase(Locale.ROOT);if(!LANGUAGES.contains(lang))return result;
        boolean hash=Arrays.asList("python","py","bash","sh","shell","powershell","ps1","ruby","rb").contains(lang);
        boolean slash=!Arrays.asList("json","html","xml","svg").contains(lang) && !hash;
        boolean markup=Arrays.asList("html","xml","svg").contains(lang);
        int n=Math.min(input.length(),MAX_CHARS),i=0;
        while(i<n && result.size()<MAX_TOKENS) {
            int start=i;char ch=input.charAt(i);
            if(hash && ch=='#' || slash && ch=='/' && i+1<n && input.charAt(i+1)=='/') { i+=ch=='#'?1:2;while(i<n&&input.charAt(i)!='\n')i++;result.add(new Token(start,i,"comment"));continue; }
            if(slash && ch=='/' && i+1<n && input.charAt(i+1)=='*') {i+=2;while(i<n && !(input.charAt(i-1)=='*'&&input.charAt(i)=='/'))i++;if(i<n)i++;result.add(new Token(start,i,"comment"));continue;}
            if(markup && ch=='<' && i+3<n && input.startsWith("<!--",i)) {i+=4;while(i<n && !(i>=2&&input.charAt(i-2)=='-'&&input.charAt(i-1)=='-'&&input.charAt(i)=='>'))i++;if(i<n)i++;result.add(new Token(start,i,"comment"));continue;}
            if(markup && ch=='<' && i+1<n) {i++;if(i<n && input.charAt(i)=='/')i++;while(i<n && (Character.isLetterOrDigit(input.charAt(i))||input.charAt(i)=='-'||input.charAt(i)==':'||input.charAt(i)=='_'))i++;if(i>start+1)result.add(new Token(start,i,"keyword"));continue;}
            if(ch=='"'||ch=='\''||ch=='`') { char quote=ch;i++;while(i<n){char c=input.charAt(i++);if(c=='\\' && i<n){i++;continue;}if(c==quote)break;}
                int next=i;while(next<n&&Character.isWhitespace(input.charAt(next)))next++;String kind=next<n&&input.charAt(next)==':'&&(lang.equals("json")||lang.equals("jsonc")||lang.equals("js")||lang.equals("javascript")||lang.equals("typescript")||lang.equals("ts"))?"key":"string";result.add(new Token(start,i,kind));continue; }
            if(Character.isDigit(ch) && (i==0 || !Character.isJavaIdentifierPart(input.charAt(i-1)))) {i++;while(i<n&&(Character.isLetterOrDigit(input.charAt(i))||input.charAt(i)=='.'||input.charAt(i)=='_'||((input.charAt(i)=='+'||input.charAt(i)=='-') && (input.charAt(i-1)=='e'||input.charAt(i-1)=='E'))))i++;result.add(new Token(start,i,"number"));continue;}
            if(Character.isJavaIdentifierStart(ch)) {i++;while(i<n&&Character.isJavaIdentifierPart(input.charAt(i)))i++;String word=input.substring(start,i);if(KEYWORDS.contains(word)||lang.equals("sql")&&KEYWORDS.contains(word.toUpperCase(Locale.ROOT)))result.add(new Token(start,i,"keyword"));continue;}
            i++;
        }
        return result;
    }
}
