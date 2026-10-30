package com.cortex.mobile;

import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashSet;
import java.util.List;

/** Tracks models received from one connection, including an existing offline selection. */
final class CatalogSelection {
    private String saved="", selected=""; private boolean keepSaved; private long generation;
    private final ArrayList<String> models=new ArrayList<>();
    void load(String previous,boolean mayKeep){ saved=previous==null?"":previous;invalidate(mayKeep); }
    void invalidate(boolean mayKeep){ generation++;keepSaved=mayKeep&&!saved.isEmpty();models.clear();selected="";if(keepSaved){models.add(saved);selected=saved;} }
    long begin(){return ++generation;}
    boolean apply(long ticket,Collection<String> fetched){
        if(ticket!=generation)return false;
        LinkedHashSet<String> unique=new LinkedHashSet<>();for(String id:fetched)if(id!=null&&!id.trim().isEmpty()&&id.length()<=200)unique.add(id);
        String previous=selected;models.clear();models.addAll(unique);selected=models.contains(previous)?previous:"";return true;
    }
    List<String> models(){return new ArrayList<>(models);}
    String selected(){return selected;}
    void select(String id){selected=models.contains(id)?id:"";}
}
