package com.cortex.mobile;
public final class ToolGroupingTest {
 public static void main(String[] args){
  if(!ToolGrouping.category("list_files").equals(ToolGrouping.category("read_file"))) throw new AssertionError("reads should group");
  if(!ToolGrouping.category("grep").equals(ToolGrouping.category("search_text"))) throw new AssertionError("search should group");
  if(ToolGrouping.category("search_text").equals(ToolGrouping.category("read_file"))) throw new AssertionError("separate categories");
  if(!ToolGrouping.category("write_file").equals(ToolGrouping.category("run_command")))throw new AssertionError("mixed operations");
  java.util.List<String> reads=java.util.Arrays.asList("read_file","list_files","read_file","list_files","read_file");
  String title=ToolGrouping.label("operations",reads,1,2,"");if(!title.contains("5 次")||!title.contains("1 进行中")||!title.contains("2 失败"))throw new AssertionError(title);
  if(!ToolGrouping.label("operations",reads,0,0,"").contains("读取了文件和文件列表"))throw new AssertionError("finished title");
  if(!ToolGrouping.label("operations",java.util.Arrays.asList("read_file","run_command"),0,0,"").contains("运行了命令  2 项操作"))throw new AssertionError("mixed title");
  if(!ToolGrouping.label("operations",java.util.Arrays.asList("write_file","run_command"),0,0,"").contains("编辑了文件并运行了命令"))throw new AssertionError("edit and command");
  System.out.println("Tool grouping passed");
 }
}
