package com.cortex.mobile;

public final class ProjectNameTest {
    private static void expect(String expected, String input) {
        String actual=ProjectName.abbreviate(input);
        if(!expected.equals(actual)) throw new AssertionError(input + " => " + actual);
    }
    public static void main(String[] args) {
        expect("十二三四五六", "十二三四五六");
        expect("十二三四五六...", "十二三四五六七");
        expect("abc中文defgh", "abc中文defgh");
        expect("abc中文defgh...", "abc中文defghi");
        expect("1234567890😀...", "1234567890😀x");
        expect("abcdefghijé", "abcdefghijé");
        System.out.println("Project name abbreviation passed");
    }
}
