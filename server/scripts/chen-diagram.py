import subprocess, sys
K,P,M,N='key','partial','multi','plain'
def a(s):
    if s.startswith('_'): return (s[1:],K)
    if s.startswith('~'): return (s[1:],P)
    if s.endswith('[]'): return (s[:-2],M)
    return (s,N)
COL={'acc':('#1A56DB','#E8F0FE'),'vault':('#137333','#E6F4EA'),'exam':('#B06000','#FEF3E2'),'leak':('#C5221F','#FCE8E6')}
# entity: name -> (module, weak, attrs)
E={
'USER':('acc',0,'_user_id name email role status totp_secret password_hash'),
'SESSION':('acc',0,'_session_id refresh_hash expires_at ip'),
'FACE_TEMPLATE':('acc',1,'descriptor model enrolled_at'),
'FACE_CHALLENGE':('acc',0,'_challenge_id purpose poses[] expires_at'),
'FACE_CHECK':('acc',0,'_check_id passed match_distance yaw_values[]'),
'AUDIT_LOG':('acc',0,'_log_id action entity payload prev_hash row_hash'),
'DOCUMENT':('vault',0,'_document_id title category threshold_k total_shares_n unlock_at status copies_per_reader'),
'DOCUMENT_BLOB':('vault',1,'iv auth_tag ciphertext sha256'),
'RELEASE':('vault',1,'released_at wrapped_key custodian_ids[]'),
'DOCUMENT_COPY':('vault',0,'_copy_id copy_code copy_no stamped issued_at'),
'EXAM':('exam',0,'_exam_id name'),
'PAPER':('exam',0,'_paper_id subject title status seal_deadline unlock_at exam_start threshold_k'),
'CENTRE':('exam',0,'_centre_id code name city'),
'BLUEPRINT_ITEM':('exam',1,'~position topic difficulty count_needed marks_each'),
'QUESTION':('exam',0,'_question_id body_enc body_hmac status option_count'),
'VARIANT':('exam',0,'_variant_id question_order[] option_orders signature'),
'PRINTED_COPY':('leak',0,'_copy_id copy_no copy_code printed_at voided_at'),
'REPRINT_REQUEST':('leak',0,'_request_id reason status decided_at'),
'LEAK_REPORT':('leak',0,'_leak_id source leaked_text phase confidence summary'),
}
# relationship: (name, identifying, [(entity, card, total)], attrs, module, table)
R=[
('LOGS IN',0,[('USER','1',0),('SESSION','N',1)],'', 'acc','sessions'),
('ENROLLS',1,[('USER','1',0),('FACE_TEMPLATE','1',1)],'', 'acc','face_templates'),
('IS SENT',0,[('USER','1',0),('FACE_CHALLENGE','N',1)],'', 'acc','face_challenges'),
('UNDERGOES',0,[('USER','1',0),('FACE_CHECK','N',1)],'', 'acc','face_checks'),
('ANSWERED BY',0,[('FACE_CHALLENGE','1',0),('FACE_CHECK','N',0)],'', 'acc','face_checks.challenge_id'),
('PERFORMS',0,[('USER','1',0),('AUDIT_LOG','N',0)],'', 'acc','audit_log.actor_id'),
('CREATES',0,[('USER','1',0),('DOCUMENT','N',1)],'', 'vault','documents.created_by'),
('STORED AS',1,[('DOCUMENT','1',1),('DOCUMENT_BLOB','1',1)],'', 'vault','document_blobs'),
('OPENED BY',1,[('DOCUMENT','1',0),('RELEASE','1',1)],'', 'vault','releases'),
('HOLDS SHARE',0,[('USER','M',0),('DOCUMENT','N',1)],'share_index share_hash picked_up_at', 'vault','key_shares'),
('SUBMITS SHARE',0,[('USER','M',0),('DOCUMENT','N',0)],'accepted reason submitted_at', 'vault','share_submissions'),
('STAGES SHARE',0,[('USER','M',0),('DOCUMENT','N',0)],'share_enc accepted_at', 'vault','pending_shares'),
('MAY READ',0,[('USER','M',0),('DOCUMENT','N',0)],'', 'vault','document_recipients'),
('DOWNLOADS',0,[('USER','M',0),('DOCUMENT','N',0)],'downloaded_at ip', 'vault','downloads'),
('ISSUES',0,[('DOCUMENT','1',0),('DOCUMENT_COPY','N',1)],'', 'vault','document_copies.document_id'),
('RECEIVES',0,[('USER','1',0),('DOCUMENT_COPY','N',1)],'', 'vault','document_copies.reader_id'),
('SETS UP',0,[('USER','1',0),('EXAM','N',1)],'', 'exam','exams.created_by'),
('CONTAINS',0,[('EXAM','1',0),('PAPER','N',1)],'', 'exam','papers.exam_id'),
('HAS BLUEPRINT',1,[('PAPER','1',0),('BLUEPRINT_ITEM','N',1)],'', 'exam','blueprint_items'),
('SETS',0,[('USER','M',0),('PAPER','N',0)],'', 'exam','paper_setters'),
('GUARDS',0,[('USER','M',0),('PAPER','N',0)],'', 'exam','paper_custodians'),
('WRITES',0,[('USER','1',0),('QUESTION','N',1)],'', 'exam','questions.setter_id'),
('FILLS',0,[('QUESTION','N',1),('BLUEPRINT_ITEM','1',0)],'', 'exam','questions (topic, difficulty)'),
('HELD AT',0,[('PAPER','M',0),('CENTRE','N',0)],'candidate_count print_buffer superintendent', 'exam','paper_centres'),
('DRAWS',0,[('PAPER','M',0),('QUESTION','N',0)],'position section marks', 'exam','final_questions'),
('GETS VARIANT',0,[('PAPER','1',0),('CENTRE','1',0),('VARIANT','1',1)],'', 'exam','variants'),
('SEALED AS',0,[('PAPER','1',0),('DOCUMENT','1',0)],'', 'exam','documents.paper_id'),
('PRINTED AS',0,[('VARIANT','1',0),('PRINTED_COPY','N',1)],'', 'leak','printed_copies.variant_id'),
('PRINTS',0,[('USER','1',0),('PRINTED_COPY','N',1)],'', 'leak','printed_copies.printed_by'),
('SPOILED IN',0,[('PRINTED_COPY','1',0),('REPRINT_REQUEST','N',1)],'', 'leak','reprint_requests.copy_id'),
('REPLACED BY',0,[('REPRINT_REQUEST','1',0),('PRINTED_COPY','0..1',0)],'', 'leak','printed_copies.reprint_request_id'),
('REQUESTS',0,[('USER','1',0),('REPRINT_REQUEST','N',1)],'', 'leak','reprint_requests.requested_by'),
('DECIDES',0,[('USER','1',0),('REPRINT_REQUEST','N',0)],'', 'leak','reprint_requests.decided_by'),
('REPORTS',0,[('USER','1',0),('LEAK_REPORT','N',1)],'', 'leak','leak_reports.reported_by'),
('LEAK OF PAPER',0,[('PAPER','1',0),('LEAK_REPORT','N',0)],'', 'leak','leak_reports.paper_id'),
('LEAK OF DOC',0,[('DOCUMENT','1',0),('LEAK_REPORT','N',0)],'', 'leak','leak_reports.document_id'),
('TRACED TO',0,[('PRINTED_COPY','1',0),('LEAK_REPORT','N',0)],'', 'leak','matched_copy_id'),
('TRACED TO COPY',0,[('DOCUMENT_COPY','1',0),('LEAK_REPORT','N',0)],'', 'leak','matched_document_copy_id'),
('POINTS TO',0,[('VARIANT','1',0),('LEAK_REPORT','N',0)],'', 'leak','matched_variant_id'),
('MATCHES',0,[('LEAK_REPORT','M',0),('QUESTION','N',0)],'setter_id', 'leak','leak_matches'),
('BURNS',0,[('LEAK_REPORT','1',0),('QUESTION','N',0)],'', 'leak','questions.burned_by_leak'),
]
def lab(t): return t.replace('&','&amp;').replace('<','&lt;')
def render(fname, title, mods, attrs=True, engine='dot'):
    ents=set(e for e,v in E.items() if v[0] in mods)
    rels=[r for r in R if r[4] in mods]
    stub=set()
    for r in rels:
        for e,_,_ in r[2]:
            if e not in ents: stub.add(e)
    o=['graph G {', f'graph [layout={engine}, overlap=false, sep="+14", splines=true, outputorder=edgesfirst, pad=0.5, nodesep=0.35, ranksep=0.5, fontname="Helvetica", labelloc=t, fontsize=24, label=<<B>{title}</B><BR/><FONT POINT-SIZE="13">Chen notation · rectangle = entity · double rectangle = weak entity · diamond = relationship · double diamond = identifying relationship<BR/>oval = attribute · <U>underlined</U> = primary key · dashed oval = partial key of a weak entity · double oval = multivalued · double line = total participation · 1 / N / M = cardinality</FONT>>];',
       'node [fontname="Helvetica"]; edge [color="#5F6368", penwidth=1.3, fontname="Helvetica", fontsize=14, fontcolor="#202124"];']
    for e in sorted(ents|stub):
        m,weak,at=E[e]; c,bg=COL[m]; st= e in stub
        o.append(f'"{e}" [shape=box, style="filled{",dashed" if st else ""}", fillcolor="{"white" if st else bg}", color="{c}", penwidth={1.5 if st else 2.4}, peripheries={2 if weak else 1}, fontsize=16, label=<<B>{e}</B>{"<BR/><FONT POINT-SIZE=\'10\'>(see " + {"acc":"accounts","vault":"key vault","exam":"exam papers","leak":"printing and leaks"}[m] + ")</FONT>" if st else ""}>, margin="0.25,0.12"];')
        if attrs and not st:
            for i,s in enumerate(at.split()):
                nm,k=a(s); nid=f'{e}.{nm}'
                t={K:f'<U>{nm}</U>',P:f'<U>{nm}</U>',M:nm,N:nm}[k]
                o.append(f'"{nid}" [shape=ellipse, style="filled{",dashed" if k==P else ""}", fillcolor="white", color="{c}", peripheries={2 if k==M else 1}, fontsize=12, label=<{t}>, margin="0.05,0.02"];')
                o.append(f'"{e}" -- "{nid}" [color="{c}", penwidth=1];')
    for i,(rn,ident,parts,ra,m,tbl) in enumerate(rels):
        c,bg=COL[m]; rid=f'R{i}'
        o.append(f'"{rid}" [shape=diamond, style=filled, fillcolor="{bg}", color="{c}", penwidth=2, peripheries={2 if ident else 1}, fontsize=12, label=<<B>{rn}</B><BR/><FONT POINT-SIZE="9" COLOR="#5F6368">{lab(tbl)}</FONT>>, margin="0.02,0.02"];')
        for e,card,tot in parts:
            col= f'"{c}:invis:{c}"' if tot else f'"{c}"'
            o.append(f'"{e}" -- "{rid}" [color={col}, penwidth={1.4 if tot else 1.6}, label=<<B>{card}</B>>, len=1.6];')
        if attrs:
            for s in ra.split():
                nid=f'{rid}.{s}'
                o.append(f'"{nid}" [shape=ellipse, style=filled, fillcolor="white", color="{c}", fontsize=12, label="{s}", margin="0.05,0.02"];')
                o.append(f'"{rid}" -- "{nid}" [color="{c}", penwidth=1];')
    o.append('}')
    open(fname+'.dot','w').write('\n'.join(o))
    for fmt in ['png','svg']:
        subprocess.run(['dot' if engine=='dot' else engine,f'-T{fmt}']+(['-Gdpi=170'] if fmt=='png' else [])+[fname+'.dot','-o',f'{fname}.{fmt}'],stderr=subprocess.DEVNULL)
eng=sys.argv[1] if len(sys.argv)>1 else 'neato'
render('chen0','SealedPaper ER diagram: all entities and relationships',['acc','vault','exam','leak'],attrs=False,engine=eng)
render('chen1','ER diagram 1 of 4: Accounts, face verification and audit',['acc'],engine=eng)
render('chen2','ER diagram 2 of 4: Key vault (any confidential document)',['vault'],engine=eng)
render('chen3','ER diagram 3 of 4: Exam papers',['exam'],engine=eng)
render('chen4','ER diagram 4 of 4: Printing, reprints and leak tracing',['leak'],engine=eng)
