package com.cortex.mobile;

import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/** Presentation labels only: tool identifiers and payloads remain unchanged. */
final class ToolNames {
    private static final Map<String,String[]> LABELS=new HashMap<>();
    static {
        put("list_files","浏览项目文件","读取文件列表");put("read_file","读取文件","读取文件");put("write_file","写入文件","写入文件");put("replace_in_file","修改文件","修改文件");
        put("search_text","搜索代码","完成搜索");put("search_files","搜索代码","完成搜索");put("run_command","运行命令","运行命令");put("undo_last_change","撤销文件修改","撤销文件修改");
        put("view_image","查看图片","查看图片");put("browser_navigate","打开网页","打开网页");put("browser_snapshot","读取页面","读取页面");put("browser_click","点击页面元素","点击页面元素");put("browser_type","填写页面内容","填写页面内容");put("browser_scroll","滚动页面","滚动页面");put("browser_screenshot","截取网页","保存网页截图");
        put("spawn_agent","分配子任务","分配子任务");put("wait_agents","等待子任务","等待子任务");put("send_agent_message","补充子任务说明","补充子任务说明");put("stop_agent","停止子任务","停止子任务");put("ask_user_question","请求用户回答","请求用户回答");
        put("read_url","读取网页","读取网页");put("apply_patch","修改文件","修改文件");put("delete_file","删除文件","删除文件");
        alias("bash","run_command");alias("execute_command","run_command");alias("read","read_file");alias("write","write_file");alias("edit","replace_in_file");alias("glob","list_files");alias("grep","search_files");alias("webfetch","read_url");alias("websearch","search_text");
    }
    private static void put(String name,String active,String complete){LABELS.put(name,new String[]{active,complete});}
    private static void alias(String name,String target){LABELS.put(name,LABELS.get(target));}
    private static String safe(String value,int limit){if(value==null)return "";StringBuilder out=new StringBuilder();boolean space=false;for(int i=0;i<value.length()&&out.length()<limit;i++){char c=value.charAt(i);int type=Character.getType(c);if(Character.isISOControl(c)||type==Character.FORMAT||Character.isWhitespace(c)){space=out.length()>0;continue;}if(space&&out.length()<limit)out.append(' ');space=false;if(out.length()<limit)out.append(c);}return out.toString();}
    static String caption(String name,boolean done,boolean failed,String detail){
        String original=name==null?"":name.replace("（模拟）","").trim();String[] labels=LABELS.get(original.toLowerCase(Locale.ROOT));
        String text;if(labels==null){String unknown=safe(original,80);text=done?(failed?"工具执行失败":"工具已返回"):"正在执行工具";if(!unknown.isEmpty())text+=" · "+unknown;}
        else text=done?(failed?labels[0]+"失败":"已"+labels[1]):"正在"+labels[0];
        String path=safe(detail,180);return path.isEmpty()?text:text+" · "+path;
    }
    static String status(String value){if(value==null)return "";switch(value.toLowerCase(Locale.ROOT)){case "running":return "进行中";case "pending":return "等待中";case "completed":return "已完成";case "failed":return "失败";case "stopped":case "cancelled":return "已停止";default:return safe(value,40);}}
    private ToolNames(){}
}
