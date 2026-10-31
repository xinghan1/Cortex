package com.cortex.mobile;

import java.util.Locale;
/** Adjacent operations of the same kind share a summary; identifiers remain intact. */
final class ToolGrouping {
    static String category(String name) {
        String n=name==null?"":name.replace("（模拟）", "").trim().toLowerCase(Locale.ROOT);
        switch(n) {
            case "read_file": case "read": case "list_files": case "glob": return "read";
            case "search_files": case "search_text": case "grep": return "search";
            case "run_command": case "execute_command": case "bash": return "command";
            default: return "tool:"+n;
        }
    }
    static String label(String category, int total, int waiting, int failed, String fallback) {
        String title;
        switch(category) {
            case "read": title=waiting>0?"正在读取文件和文件列表":"读取了文件和文件列表"; break;
            case "search": title=waiting>0?"正在搜索":"已完成搜索"; break;
            case "command": title="运行命令"; break;
            default: title=fallback;
        }
        String suffix=" · "+total+" 次";
        if(waiting>0)suffix+=" · "+waiting+" 进行中";
        if(failed>0)suffix+=" · "+failed+" 失败";
        return title+suffix;
    }
    private ToolGrouping() {}
}
