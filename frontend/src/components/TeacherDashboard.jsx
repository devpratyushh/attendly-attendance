import { useEffect, useState } from 'react';
import { api } from '../api';
import Icon from './Icon';
import Empty from './Empty';

export default function TeacherDashboard({ assignments, onNavigate, onSelectAssignment }) {
  const [sessions, setSessions] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => { let active=true; api.getSessions().then(value => { if(active) setSessions(value); }).catch(e => { if(active) setError(e.message); }); return ()=>{active=false;}; }, []);
  if (!sessions) return error ? <div className="notice error">{error}</div> : <div className="loading"><div className="spinner"/>Loading teaching activity…</div>;
  const confirmed=sessions.filter(s=>s.status==='confirmed');
  const pending=sessions.length-confirmed.length;
  return <>
    <div className="stats-grid">{[['Assigned subjects',assignments.length,'book','Ready for attendance'],['Classes',new Set(assignments.map(a=>a.class_id)).size,'school','Your assigned classrooms'],['Finalized sessions',confirmed.length,'check','Safely saved attendance'],['In review',pending,'clock','Awaiting your confirmation']].map(([label,value,icon,detail])=><div className="stat-card" key={label}><span>{label}<Icon name={icon}/></span><strong>{value.toString().padStart(2,'0')}</strong><small>{detail}</small></div>)}</div>
    <div className="dashboard-grid"><div className="card dashboard-card"><div className="dashboard-card-heading"><div><h2>Your subjects</h2><p>Everything you teach, in one place.</p></div><Icon name="book"/></div>{assignments.length ? assignments.map(a=><div className="dashboard-list-row" key={a.id}><span className="soft-icon"><Icon name="book" size={18}/></span><div><strong>{a.subject_name}</strong><span>{a.subject_code} · {a.class_name}</span></div><button className="icon-button" aria-label={`Take attendance for ${a.subject_name}`} onClick={()=>onSelectAssignment(a.id)}><Icon name="arrow" size={18}/></button></div>) : <Empty icon="book" title="No subjects assigned yet" description="Your class teacher can assign your teaching subjects."/>}</div>
    <div className="card dashboard-card"><div className="dashboard-card-heading"><div><h2>Recent sessions</h2><p>Your latest attendance activity.</p></div><button className="text-button" onClick={()=>onNavigate('history')}>View all<Icon name="arrow" size={16}/></button></div>{sessions.length ? sessions.slice(0,5).map(s=><button className="dashboard-list-row session-shortcut" key={s.session_id} onClick={()=>onNavigate('history')}><span className="soft-icon"><Icon name="clock" size={18}/></span><span className="session-shortcut-copy"><strong>{s.subject_name}</strong><span>{new Date(s.date).toLocaleDateString('en-IN',{day:'numeric',month:'short'})} · {s.class_name}</span></span><span className={`badge badge-${s.status==='confirmed'?'present':'uncertain'}`}>{s.status==='confirmed'?'Finalized':'In review'}</span></button>) : <Empty icon="camera" title="Your next lecture starts here" description="Capture your first class to see your activity." action={()=>onNavigate('attendance')} actionLabel="Take attendance"/>}</div></div>
  </>;
}
