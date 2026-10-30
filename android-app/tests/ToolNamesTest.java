package com.cortex.mobile;

public final class ToolNamesTest {
    private static void is(String actual,String expected){if(!actual.equals(expected))throw new AssertionError("expected "+expected+" but got "+actual);}
    public static void main(String[] args){
        String[][] shown={{"replace_in_file","修改文件"},{"browser_navigate","打开网页"},{"browser_snapshot","读取页面"},{"run_command","运行命令"},{"search_files","搜索代码"},{"browser_click","点击页面元素"},{"browser_screenshot","截取网页"},{"view_image","查看图片"},{"list_files","浏览项目文件"},{"read_file","读取文件"},{"write_file","写入文件"},{"spawn_agent","分配子任务"}};
        for(String[] item:shown){is(ToolNames.caption(item[0],false,false,""),"正在"+item[1]);is(ToolNames.caption(item[0],true,true,""),item[1]+"失败");}
        is(ToolNames.caption("replace_in_file",true,false,"a.txt"),"已修改文件 · a.txt");
        is(ToolNames.caption("browser_navigate",true,false,"https://example.com"),"已打开网页 · https://example.com");
        is(ToolNames.caption("browser_screenshot",true,false,""),"已保存网页截图");
        is(ToolNames.caption("view_image",true,false,""),"已查看图片");
        is(ToolNames.caption("run_command",true,true,""),"运行命令失败");
        is(ToolNames.caption("unknown\u202Ename",false,false,"a\nb"),"正在执行工具 · unknown name · a b");
        is(ToolNames.caption("",true,false,""),"工具已返回");is(ToolNames.status("running"),"进行中");is(ToolNames.status("completed"),"已完成");is(ToolNames.status("failed"),"失败");
        System.out.println("Tool labels passed");
    }
}
