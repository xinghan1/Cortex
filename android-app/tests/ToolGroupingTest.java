package com.cortex.mobile;
public final class ToolGroupingTest {
 public static void main(String[] args){
  if(!ToolGrouping.category("list_files").equals(ToolGrouping.category("read_file"))) throw new AssertionError("reads should group");
  if(!ToolGrouping.category("grep").equals(ToolGrouping.category("search_text"))) throw new AssertionError("search should group");
  if(ToolGrouping.category("search_text").equals(ToolGrouping.category("read_file"))) throw new AssertionError("separate categories");
  String title=ToolGrouping.label("read",5,1,2,"");if(!title.contains("5 次")||!title.contains("1 进行中")||!title.contains("2 失败"))throw new AssertionError(title);
  if(!ToolGrouping.label("read",5,0,0,"").contains("读取了文件和文件列表"))throw new AssertionError("finished title");
  System.out.println("Tool grouping passed");
 }
}
