package com.cortex.mobile;

import java.util.Arrays;

public final class CatalogSelectionTest {
    public static void main(String[] args) {
        CatalogSelection s=new CatalogSelection();s.load("previous-model",true);
        if(!"previous-model".equals(s.selected()))throw new AssertionError("existing offline model lost");
        long old=s.begin();s.invalidate(false);
        if(s.apply(old,Arrays.asList("stale-model"))||!s.selected().isEmpty()||!s.models().isEmpty())throw new AssertionError("stale connection result accepted");
        long current=s.begin();if(!s.apply(current,Arrays.asList("one","two","one","")))throw new AssertionError("current catalog rejected");
        if(s.models().size()!=2||!s.selected().isEmpty())throw new AssertionError("catalog must be deduplicated and explicitly selected");
        s.select("not-from-catalog");if(!s.selected().isEmpty())throw new AssertionError("arbitrary model accepted");
        s.select("two");if(!"two".equals(s.selected()))throw new AssertionError("catalog selection not retained");
        s.load("previous-model",true);long refresh=s.begin();s.apply(refresh,Arrays.asList("new-model"));
        if(s.models().contains("previous-model")||!s.selected().isEmpty())throw new AssertionError("a successful refresh must not offer a model absent from its catalog");
        System.out.println("Model catalog selection passed");
    }
}
