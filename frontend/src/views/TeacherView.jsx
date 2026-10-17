import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import TakeAttendance from '../components/TakeAttendance';
import SessionHistory from '../components/SessionHistory';
import Icon from '../components/Icon';
import Empty from '../components/Empty';
import TeacherDashboard from '../components/TeacherDashboard';
import { cacheWorkspace, readWorkspace, offlineModules } from '../offline/client';

export default function TeacherView({ page, onNavigate, user, historySessionId }) {
  const navigate=useNavigate();const [params,setParams]=useSearchParams();
  const requested=params.get('assignment');const sessionId=params.get('session');const jobId=params.get('job');
  const contextKey=JSON.stringify([requested,sessionId,jobId]);
  const hasContext=Boolean(sessionId || jobId);
  const [workspace,setWorkspace]=useState(null);
  const [roster,setRoster]=useState(null);
  const [resolved,setResolved]=useState(null);
  useEffect(()=>{
    let active=true;
    (async()=>{
      try {const data=await api.getAssignments();if(active)setWorkspace({assignments:data});cacheWorkspace(user.id,'assignments',data).catch(()=>{});}
      catch(e){const cached=!e.status?await readWorkspace(user.id,'assignments').catch(()=>null):null;if(active)setWorkspace(cached?{assignments:cached}:{assignments:[],error:'Connect to load your assigned classes. '+e.message});}
    })();return()=>{active=false;};
  },[user.id]);
  useEffect(()=>{
    if(!hasContext)return;
    let active=true;
    (async()=>{
      try {
        if(sessionId && jobId)throw new Error('Open either a saved session or a local capture.');
        let session=null,job=null;
        if(jobId){const {store}=await offlineModules();job=await store.get('jobs',jobId);if(!job || job.owner!==user.id)throw new Error('This local capture is unavailable for your account on this device.');}
        else {session=await api.getSession(sessionId);if(session.status==='confirmed'){if(active)navigate(`/teacher/history/${encodeURIComponent(sessionId)}`,{replace:true});return;}}
        const assignmentId=job?.assignmentId || session?.assignment_id;
        if(requested && Number(requested)!==assignmentId)throw new Error('This capture belongs to a different subject. Open it from session history or the device queue.');
        if(active)setResolved({key:contextKey,session,job,assignmentId});
      }catch(e){if(active)setResolved({key:contextKey,error:e.message});}
    })();return()=>{active=false;};
  },[contextKey,hasContext,jobId,sessionId,requested,user.id,navigate]);
  const context=hasContext && resolved?.key===contextKey?resolved:null;
  const assignments=workspace?.assignments || [];
  const selectedId=requested ? Number(requested) : context?.assignmentId || assignments[0]?.id;
  const assignment=assignments.find(item=>item.id===selectedId);
  const classId=assignment?.class_id;
  useEffect(()=>{
    if(!classId)return;
    let active=true;
    (async()=>{
      try {const students=await api.getStudents(classId);if(active)setRoster({classId,students});cacheWorkspace(user.id,`roster:${classId}`,students.map(({photos:_photos,...student})=>({...student,photos:[]}))).catch(()=>{});}
      catch(e){const cached=!e.status?await readWorkspace(user.id,`roster:${classId}`).catch(()=>null):null;if(active)setRoster({classId,students:cached || [],error:cached?null:e.message});}
    })();return()=>{active=false;};
  },[classId,user.id]);
  const openAssignment=id=>navigate(`/teacher/attendance?${new URLSearchParams({assignment:String(id)})}`);
  const openJob=job=>setParams({assignment:String(job.assignmentId),job:job.id});
  const openConfirmedSession=useCallback(id=>navigate(`/teacher/history/${encodeURIComponent(id)}`,{replace:true}),[navigate]);
  const resume=session=>navigate(`/teacher/attendance?${new URLSearchParams({assignment:String(session.assignment_id),session:session.session_id})}`);
  if(!workspace || (page==='attendance' && hasContext && !context))return <div className="loading"><div className="spinner"/>Loading your classroom…</div>;
  const error=workspace.error || (page==='attendance' && (context?.error || (requested && (!/^\d+$/.test(requested) || !assignment)?'This subject is not assigned to your account.':null) || roster?.classId===classId && roster?.error));
  const students=roster?.classId===classId?roster.students:[];
  return <>
    <div className="page-heading"><div><div className="eyebrow">Your classroom</div><h1>{page==='history'?'Session history':page==='overview'?`Welcome back, ${user.name.split(' ')[0]}`:'Take attendance'}</h1><p>{page==='history'?'Your saved lectures and finalized attendance.':page==='overview'?'Your teaching activity, at a glance.':'A clear photo. A quick review. Back to teaching.'}</p></div><span className="workspace-chip"><Icon name="shield" size={16}/>Teacher workspace</span></div>
    {error && <div className="notice error" role="alert">{error}{page==='attendance' && <button className="text-button" onClick={()=>onNavigate('attendance')}>Return to attendance</button>}</div>}
    {page==='overview'?<TeacherDashboard assignments={assignments} onNavigate={onNavigate} onSelectAssignment={openAssignment}/>:page==='history'?<SessionHistory key={historySessionId || 'list'} sessionId={historySessionId} onSelectSession={session=>navigate(`/teacher/history/${encodeURIComponent(session.session_id)}`)} onBack={()=>navigate('/teacher/history')} onResume={resume}/>:error?null:!assignments.length?<Empty icon="book" title="Your subjects will appear here." description="Your class teacher or administrator can assign your teaching subjects."/>:<>
      <div className="subject-selector card"><label className="field">Subject & class<select value={String(selectedId)} onChange={e=>setParams({assignment:e.target.value})}>{assignments.map(item=><option key={item.id} value={item.id}>{item.subject_name} · {item.subject_code} · {item.class_name}</option>)}</select></label><span className="roster-count"><Icon name="users" size={18}/>{students.length} students</span></div>
      {roster?.classId!==classId?<div className="loading"><div className="spinner"/>Loading class roster…</div>:students.length?<div className="attendance-panel"><TakeAttendance key={`${selectedId}-${jobId || sessionId || 'new'}`} students={students} assignmentId={selectedId} initialSession={context?.session} owner={user.id} initialJob={context?.job} onOpenJob={openJob} onConfirmed={openConfirmedSession} onResetRequest={()=>setParams({assignment:String(selectedId)})} assignmentLabel={`${assignment.subject_name} · ${assignment.class_name}`}/></div>:<Empty icon="users" title="This class is waiting for its students." description="Ask your class teacher to add students before taking attendance."/>}
    </>}
  </>;
}
