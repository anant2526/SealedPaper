import psycopg2, html, collections, subprocess
c=psycopg2.connect("postgresql://postgres:postgres@localhost:5432/sealedpaper").cursor()
c.execute("""select table_name,column_name,
 case when data_type='USER-DEFINED' then udt_name when data_type='ARRAY' then substr(udt_name,2)||'[]' when data_type like 'timestamp%' then 'timestamptz' when data_type='character varying' then 'varchar' else data_type end, is_nullable
 from information_schema.columns c where table_schema='public' and table_name in (select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE') order by table_name, ordinal_position""")
cols=collections.defaultdict(list)
for t,col,ty,n in c.fetchall():
    if t!='schema_migrations': cols[t].append((col,ty,n))
c.execute("""select conrelid::regclass::text, contype, conname, array(select attname from unnest(conkey) k join pg_attribute a on a.attrelid=conrelid and a.attnum=k), confrelid::regclass::text
 from pg_constraint where connamespace='public'::regnamespace and contype in ('p','f','u')""")
pk=collections.defaultdict(set);fk=collections.defaultdict(set);uk=collections.defaultdict(list);fks=[]
for t,ty,nm,ks,ref in c.fetchall():
    if ty=='p': pk[t]|=set(ks); uk[t].append(set(ks))
    if ty=='u': uk[t].append(set(ks))
    if ty=='f': fk[t]|=set(ks); fks.append((t,ks,ref,nm))
G={'Accounts and audit':(['users','sessions','face_templates','face_challenges','face_checks','audit_log'],'#E8F0FE','#1A56DB'),
 'Key vault':(['documents','document_blobs','key_shares','document_recipients','share_submissions','pending_shares','releases','downloads','document_copies'],'#E6F4EA','#137333'),
 'Exam papers':(['exams','centres','papers','paper_setters','paper_custodians','blueprint_items','questions','paper_centres','final_questions','variants'],'#FEF3E2','#B06000'),
 'Printing and leaks':(['printed_copies','reprint_requests','leak_reports','leak_matches'],'#FCE8E6','#C5221F')}
assert sum(len(v[0]) for v in G.values())==len(cols)==29, (len(cols), set(cols)-{x for v in G.values() for x in v[0]})
def node(t,head):
    r=[f'<TR><TD BGCOLOR="{head}" COLSPAN="3" ALIGN="CENTER"><FONT COLOR="white" POINT-SIZE="15"><B>{t}</B></FONT></TD></TR>']
    for col,ty,n in cols[t]:
        tags=[]
        if col in pk[t]: tags.append('PK')
        if col in fk[t]: tags.append('FK')
        if any(col in u and len(u)==1 for u in uk[t]) and col not in pk[t]: tags.append('UK')
        tg=','.join(tags) or ' '; b=('<B>','</B>') if 'PK' in tags else ('','')
        col_c='#B06000' if 'FK' in tags and 'PK' not in tags else '#202124'
        r.append(f'<TR><TD ALIGN="LEFT" WIDTH="34"><FONT POINT-SIZE="11" COLOR="#5F6368">{tg}</FONT></TD><TD ALIGN="LEFT">{b[0]}<FONT COLOR="{col_c}">{html.escape(col)}</FONT>{b[1]}{"" if n=="YES" else " *"}</TD><TD ALIGN="LEFT"><FONT POINT-SIZE="11" COLOR="#5F6368">{html.escape(ty)}</FONT></TD></TR>')
    return f'"{t}" [label=<<TABLE BORDER="1" CELLBORDER="0" CELLSPACING="0" CELLPADDING="4" BGCOLOR="white" COLOR="{head}">{"".join(r)}</TABLE>>];'
def render(mods, name, title, external=True, compact=False):
    out=['digraph ER {','graph [rankdir=LR, splines=spline, nodesep=0.5, ranksep=0.9, fontname="Helvetica", pad=0.4, label=<<B>'+title+'</B><BR/><FONT POINT-SIZE="11">PK primary key · FK foreign key · UK unique · * NOT NULL · crow\'s foot = many, bar = one, circle = optional</FONT>>, labelloc=t, fontsize=20];','node [shape=plain, fontname="Helvetica", fontsize=13];','edge [color="#80868B", penwidth=1.2, fontname="Helvetica", fontsize=9, fontcolor="#5F6368"];']
    keep=set(x for g in mods for x in G[g][0]); ext=set()
    for t,ks,ref,nm in fks:
        if external and (t in keep)!=(ref in keep): ext.add(ref if t in keep else t)
    for i,(g,(ts,bg,head)) in enumerate(G.items()):
        if g not in mods:
            for t in ts:
                if t in ext: out.append(f'"{t}" [label=<<TABLE BORDER="1" CELLBORDER="0" CELLPADDING="6" BGCOLOR="white" COLOR="{head}" STYLE="dashed"><TR><TD><FONT COLOR="{head}" POINT-SIZE="14"><B>{t}</B></FONT></TD></TR><TR><TD><FONT POINT-SIZE="10" COLOR="#5F6368">({g})</FONT></TD></TR></TABLE>>];')
            continue
        out.append(f'subgraph cluster_{i} {{ label=<<B>{g}</B>>; fontsize=15; style="rounded,filled"; fillcolor="{bg}"; color="{head}"; fontcolor="{head}";')
        out+= [node(t,head) if not compact else f'"{t}" [label=<<TABLE BORDER="1" CELLBORDER="0" CELLPADDING="8" BGCOLOR="{head}" COLOR="{head}"><TR><TD><FONT COLOR="white" POINT-SIZE="15"><B>{t}</B></FONT></TD></TR></TABLE>>];' for t in ts]; out.append('}')
    seen=set()
    for t,ks,ref,nm in fks:
        if not ({t,ref}<=keep|ext) or (t in ext and ref in ext): continue
        key=(t,tuple(ks),ref)
        if key in seen: continue
        seen.add(key)
        one=any(set(ks)>=u for u in uk[t])  # child side unique -> 1:1
        nullable=any(n=='YES' for col,ty,n in cols[t] if col in ks)
        # edge from parent(ref) to child(t): head at child
        ah='teeodot' if one else 'crowodot' if True else ''
        ah=('tee' if one else 'crow')+('odot' if True else '')
        tail='teeodot' if nullable else 'teetee'
        lbl=','.join(ks)
        out.append(f'"{ref}" -> "{t}" [dir=both, arrowtail={tail}, arrowhead={"teeodot" if one else "crowodot"}];')
    out.append('}')
    
    open(name+'.dot','w').write('\n'.join(out))

mods=list(G)
render(mods,'er','SealedPaper: entity-relationship diagram (29 tables)')
render(mods,'er0','SealedPaper ER overview: 29 entities and how they relate',compact=True)
for i,m in enumerate(mods):
    render([m],f'er{i+1}',f'SealedPaper ER diagram {i+1} of 4: {m}', external=(i!=0))
