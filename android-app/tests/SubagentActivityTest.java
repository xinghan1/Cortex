package com.cortex.mobile;

import java.util.ArrayList;

public final class SubagentActivityTest {
    public static void main(String[] args) {
        String events="[{\"type\":\"tool-start\",\"name\":\"search_files\",\"toolCallId\":\"1\",\"args\":{\"query\":\"hello\"}},{\"type\":\"tool-result\",\"name\":\"search_files\",\"toolCallId\":\"1\",\"result\":\"ok\",\"status\":\"completed\"},{\"type\":\"tool-result\",\"name\":\"run_command\",\"toolCallId\":\"2\",\"result\":\"unknown\"},{\"type\":\"tool-start\",\"name\":\"write_file\",\"toolCallId\":\"3\"}]";
        ArrayList<SubagentActivity.Entry> entries=SubagentActivity.parse(events);
        if(entries==null||entries.size()!=3)throw new AssertionError("pairing");
        if(!SubagentActivity.caption(entries.get(0),true).contains("已完成搜索"))throw new AssertionError("completed search");
        if(!SubagentActivity.caption(entries.get(1),true).contains("已返回"))throw new AssertionError("legacy unknown");
        if(!SubagentActivity.caption(entries.get(2),false).contains("未返回"))throw new AssertionError("stopped pending");
        entries.get(0).status="denied";if(!SubagentActivity.caption(entries.get(0),true).contains("未执行"))throw new AssertionError("denied");
        entries.get(0).status="failed";if(!SubagentActivity.caption(entries.get(0),true).contains("失败"))throw new AssertionError("failed");
        if(SubagentActivity.parse("[{broken")!=null)throw new AssertionError("truncated must retain fallback");
        System.out.println("Subagent activities passed");
    }
}
