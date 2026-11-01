package com.cortex.mobile;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

/** A turn-owned queue; closing and enqueueing are serialized at the final boundary. */
final class LocalSteeringQueue {
    static final class Entry { final String id,text; Entry(String text){this.id=UUID.randomUUID().toString();this.text=text;} }
    interface Journal { boolean save(String session,List<Entry> entries); }
    private final ArrayList<Entry> pending=new ArrayList<>(), journal=new ArrayList<>(); private String session=""; private boolean open; private Journal store;
    synchronized void setJournal(Journal value){store=value;}
    synchronized void start(String sessionId){pending.clear();journal.clear();session=sessionId;open=true;}
    synchronized boolean offer(String sessionId,String message){if(!open||!session.equals(sessionId)||pending.size()>=20)return false;Entry entry=new Entry(message);journal.add(entry);if(store!=null&&!store.save(session,new ArrayList<>(journal))){journal.remove(entry);return false;}pending.add(entry);return true;}
    synchronized List<Entry> drain(){List<Entry> result=new ArrayList<>(pending);pending.clear();return result;}
    synchronized boolean finishIfEmpty(){if(!pending.isEmpty())return false;open=false;return true;}
    synchronized List<Entry> close(){open=false;return drain();}
    synchronized void clearJournal(){if(store==null||store.save("",new ArrayList<>()))journal.clear();}
}
