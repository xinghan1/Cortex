package com.cortex.mobile;

/** Strict bounded JSON validation, used only to decide whether to color text. */
final class JsonValidity {
    private final String input; private int pos;
    private JsonValidity(String input){this.input=input;}
    static boolean isContainer(String value){
        if(value==null||value.length()>SyntaxHighlighter.MAX_CHARS)return false;
        JsonValidity p=new JsonValidity(value);try{p.ws();if(p.pos==value.length()||(value.charAt(p.pos)!='{'&&value.charAt(p.pos)!='['))return false;p.value(0);p.ws();return p.pos==value.length();}catch(IllegalArgumentException e){return false;}
    }
    private void ws(){while(pos<input.length() && (input.charAt(pos)==' '||input.charAt(pos)=='\t'||input.charAt(pos)=='\r'||input.charAt(pos)=='\n'))pos++;}
    private boolean take(char c){if(pos<input.length()&&input.charAt(pos)==c){pos++;return true;}return false;}
    private void required(char c){if(!take(c))throw new IllegalArgumentException();}
    private void literal(String s){if(!input.startsWith(s,pos))throw new IllegalArgumentException();pos+=s.length();}
    private void value(int depth){
        if(depth>64||pos>=input.length())throw new IllegalArgumentException();char c=input.charAt(pos);
        if(c=='"'){string();return;}if(c=='t'){literal("true");return;}if(c=='f'){literal("false");return;}if(c=='n'){literal("null");return;}
        if(c=='{'||c=='['){boolean object=c=='{';pos++;ws();if(take(object?'}':']'))return;while(true){if(object){string();ws();required(':');ws();}value(depth+1);ws();if(take(object?'}':']'))return;required(',');ws();} }
        number();
    }
    private void string(){required('"');while(pos<input.length()){char c=input.charAt(pos++);if(c=='"')return;if(c<0x20)throw new IllegalArgumentException();if(c=='\\'){if(pos>=input.length())throw new IllegalArgumentException();char e=input.charAt(pos++);if(e=='u'){for(int i=0;i<4;i++)if(pos>=input.length()||"0123456789abcdefABCDEF".indexOf(input.charAt(pos++))<0)throw new IllegalArgumentException();}else if("\"\\/bfnrt".indexOf(e)<0)throw new IllegalArgumentException();}}throw new IllegalArgumentException();}
    private void number(){take('-');if(take('0')){if(pos<input.length()&&Character.isDigit(input.charAt(pos)))throw new IllegalArgumentException();}else{if(pos>=input.length()||input.charAt(pos)<'1'||input.charAt(pos)>'9')throw new IllegalArgumentException();digits();}if(take('.'))digits();if(take('e')||take('E')){if(!take('+'))take('-');digits();}}
    private void digits(){int start=pos;while(pos<input.length()&&input.charAt(pos)>='0'&&input.charAt(pos)<='9')pos++;if(pos==start)throw new IllegalArgumentException();}
}
