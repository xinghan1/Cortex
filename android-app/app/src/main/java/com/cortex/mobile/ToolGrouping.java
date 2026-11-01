package com.cortex.mobile;

import java.util.Locale;
/** Adjacent operations of the same kind share a summary; identifiers remain intact. */
final class ToolGrouping {
    static String category(String name) {
        String n=name==null?"":name.replace("（模拟）", "").trim().toLowerCase(Locale.ROOT);
        switch(n) {
            case "read_file": case "read": case "list_files": case "glob": case "write_file": case "replace_in_file": case "undo_last_change": case "run_command": case "execute_command": case "bash": return "operations";
            case "search_files": case "search_text": case "grep": return "search";
            default: return "tool:"+n;
        }
    }
    static String label(String category, java.util.List<String> names, int waiting, int failed, String fallback) {
        int total=names.size(); boolean read=false,list=false,edit=false,command=false;
        for(String name:names) { String n=name==null?"":name.replace("（模拟）", "").trim().toLowerCase(Locale.ROOT);
            read |= n.equals("read_file") || n.equals("read"); list |= n.equals("list_files") || n.equals("glob");
            edit |= n.equals("write_file") || n.equals("replace_in_file") || n.equals("undo_last_change");
            command |= n.equals("run_command") || n.equals("execute_command") || n.equals("bash"); }
        String title;
        switch(category) {
            case "operations":
                if(edit&&command) title=waiting>0?"正在编辑文件并运行命令":"编辑了文件并运行了命令";
                else if(edit) title=waiting>0?"正在编辑文件":"编辑了文件";
                else if(command) title=waiting>0?"正在运行命令":"运行了命令";
                else if(read&&list) title=waiting>0?"正在读取文件和文件列表":"读取了文件和文件列表";
                else if(list) title=waiting>0?"正在读取文件列表":"读取了文件列表";
                else title=waiting>0?"正在读取文件":"读取了文件";
                break;
            case "search": title=waiting>0?"正在搜索":"已完成搜索"; break;
            default: title=fallback;
        }
        if(waiting==0&&failed>0){if(category.equals("search"))title="搜索";else if(edit&&command)title="编辑文件并运行命令";else if(edit)title="编辑文件";else if(command)title="运行命令";else if(read&&list)title="读取文件和文件列表";else if(list)title="读取文件列表";else if(read)title="读取文件";}
        String suffix="  "+total+((edit||command)?" 项操作":" 次");
        if(waiting>0)suffix+=" · "+waiting+" 进行中";
        if(failed>0)suffix+=" · "+failed+" 失败";
        return title+suffix;
    }
    private ToolGrouping() {}
}
