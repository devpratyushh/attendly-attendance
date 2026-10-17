import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import AttendanceRing from '../components/AttendanceRing';
import AttendanceChart from '../components/AttendanceChart';
import SessionDetail from '../components/SessionDetail';
import UpdateBiometric from '../components/UpdateBiometric';
import Icon from '../components/Icon';
import Empty from '../components/Empty';

export default function StudentView({ user, page, selectedSessionId, onSelectSession, onBack }) {
  const [student, setStudent] = useState(null);
  const [attendance, setAttendance] = useState(null);
  const [localSelected, setSelected] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [consentChecked, setConsentChecked] = useState(false);
  const [historySearch, setHistorySearch] = useState('');
  const [historyStatus, setHistoryStatus] = useState('all');
  const load = useCallback(async () => {
    const [profile, records] = await Promise.all([api.getStudent(user.roll_no), api.getStudentAttendance(user.roll_no)]);
    setStudent(profile); setAttendance(records);
  }, [user.roll_no]);
  useEffect(() => {
    let active = true;
    Promise.all([api.getStudent(user.roll_no), api.getStudentAttendance(user.roll_no)]).then(([profile, records]) => {
      if (active) { setStudent(profile); setAttendance(records); }
    }).catch(e => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [user.roll_no]);
  useEffect(() => {
    const refresh = () => { if (navigator.onLine && document.visibilityState === 'visible') load().catch(() => {}); };
    const timer = setInterval(refresh, 30000);
    window.addEventListener('focus', refresh);
    return () => { clearInterval(timer); window.removeEventListener('focus', refresh); };
  }, [load]);
  if (!student || !attendance) return error ? <div className="notice error" role="alert">{error}</div> : <div className="loading"><div className="spinner"/>Loading your attendance…</div>;
  const selected=selectedSessionId?attendance.sessions.find(session=>session.session_id===selectedSessionId):localSelected;
  const selectSession=session=>onSelectSession?onSelectSession(session):setSelected(session);
  const goBack=()=>{setSelected(null);onBack?.();};
  if(selectedSessionId && !selected)return <Empty icon="clock" title="Session unavailable" description="This session is not in your confirmed attendance records." action={goBack} actionLabel="Back to my attendance"/>;
  const percent = attendance.total_periods ? Math.round(100 * attendance.attended_periods / attendance.total_periods) : null;
  const history = [...attendance.sessions].reverse().filter(s => (historyStatus === 'all' || s.status === historyStatus) && `${s.subject_name} ${s.session_id}`.toLowerCase().includes(historySearch.toLowerCase()));
  const subjects = Object.values(attendance.sessions.reduce((acc,s) => { const key=s.subject_code || s.subject_name; const item=acc[key] || {name:s.subject_name,total:0,present:0}; item.total+=s.periods; if(s.status==='present') item.present+=s.periods; acc[key]=item; return acc; }, {}));
  return <>
    <div className="page-heading"><div><div className="eyebrow">{user.roll_no} · Student workspace</div><h1>{page === 'biometric' ? 'Your biometrics' : `Hello, ${user.name.split(' ')[0]}.`}</h1><p>{page === 'biometric' ? 'Keep your enrollment photos up to date for accurate attendance.' : 'Your classes and attendance, all in one place.'}</p></div>{page !== 'biometric' && <button className="btn btn-secondary" onClick={() => load().catch(e => setError(e.message))}>Refresh attendance</button>}</div>
    {error && <div className="notice error" role="alert">{error}</div>}
    {page === 'biometric' ? !student.consent_given ? <div className="card consent-card"><span className="soft-icon"><Icon name="shield" size={24}/></span><h2 className="mt-3">Your permission comes first.</h2><p className="form-hint">Your school uses enrollment photos and face embeddings to identify you in classroom photos and record attendance. Your administrator and class teacher manage these records. Your subject teachers use them when taking attendance.</p><p className="form-hint">Contact your school administrator to request removal of your biometric data.</p><label className="checkbox-field"><input type="checkbox" checked={consentChecked} onChange={e => setConsentChecked(e.target.checked)}/>I consent to the use of my photos for face recognition attendance.</label><button className="btn btn-primary" disabled={busy || !consentChecked} onClick={async () => { setBusy(true); try { await api.giveConsent(user.roll_no); await load(); } catch (e) { setError(e.message); } finally { setBusy(false); } }}>{busy ? 'Saving…' : 'Give consent & continue'}</button></div> : <div className="narrow-panel"><UpdateBiometric student={student} onBack={() => load().catch(e => setError(e.message))}/></div> : selected ? <SessionDetail session={selected} student={student} onBack={goBack}/> : <>
      <div className="dashboard-context"><span className="workspace-chip"><Icon name="school" size={15}/>{student.class_name || 'My academic record'}</span><span className="workspace-chip"><Icon name="check" size={15}/>Confirmed records only</span></div>
      <div className="stats-grid student-metrics"><div className="stat-card featured-stat"><span>Attendance rate<Icon name="grid" size={19}/></span><strong>{percent === null ? '—' : `${percent}%`}</strong><small>{attendance.total_periods ? `${attendance.attended_periods} of ${attendance.total_periods} periods attended` : 'Your first class is ahead'}</small></div>{[['Periods attended', attendance.attended_periods, 'check','Your confirmed presence'], ['Total periods', attendance.total_periods, 'book','Across recorded classes'], ['Sessions recorded', attendance.total_sessions, 'clock','Finalized by your teachers']].map(([label, value, icon, detail]) => <div className="stat-card" key={label}><span>{label}<Icon name={icon} size={19}/></span><strong>{value.toString().padStart(2, '0')}</strong><small>{detail}</small></div>)}</div>
      <div className="dashboard-grid student-insights"><div className="card dashboard-card"><div className="dashboard-card-heading"><div><h2>Attendance activity</h2><p>Your periods over time, across subjects.</p></div><span className="workspace-chip">All records</span></div>{attendance.sessions.length ? <AttendanceChart sessions={attendance.sessions}/> : <Empty icon="clock" title="Your progress starts with your first class" description="Your chart appears when your teacher confirms attendance."/>}</div><div className="card dashboard-card ring-card"><div className="dashboard-card-heading"><div><h2>Your attendance</h2><p>Every confirmed period counts.</p></div><Icon name="grid" size={18}/></div><AttendanceRing attended={attendance.attended_periods} total={attendance.total_periods}/><div className="ring-legend"><span><i/>Attended · {attendance.attended_periods}</span><span><i/>Absent · {attendance.total_periods-attendance.attended_periods}</span></div></div></div>
      {subjects.length > 0 && <div className="card dashboard-card mt-4"><div className="dashboard-card-heading"><div><h2>Subject overview</h2><p>Your attendance for each subject.</p></div><Icon name="book" size={18}/></div><div className="subject-progress-grid">{subjects.map(s=><div className="subject-progress" key={s.name}><div><strong>{s.name}</strong><span>{Math.round(100*s.present/s.total)}%</span></div><div className="progress-track"><span style={{width:`${100*s.present/s.total}%`}}/></div><small>{s.present} of {s.total} periods attended</small></div>)}</div></div>}
      <div className="section-heading"><div><h2>Class history</h2><p>Your own attendance, session by session.</p></div></div>
      {attendance.sessions.length ? <><div className="table-toolbar"><label className="search-field"><Icon name="search" size={17}/><input aria-label="Search class history" placeholder="Search subjects or sessions…" value={historySearch} onChange={e=>setHistorySearch(e.target.value)}/></label><select aria-label="Filter attendance status" value={historyStatus} onChange={e=>setHistoryStatus(e.target.value)}><option value="all">All statuses</option><option value="present">Present</option><option value="absent">Absent</option></select></div>{history.length ? <div className="table-container"><table><thead><tr><th>Subject</th><th>Date & time</th><th>Periods</th><th>Status</th><th/></tr></thead><tbody>{history.map(s => <tr key={s.session_id}><td><strong>{s.subject_name}</strong><span className="cell-subtext">{s.session_id}</span></td><td>{new Date(s.date).toLocaleDateString('en-IN')}<span className="cell-subtext">{new Date(s.date).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })}</span></td><td>{s.periods}</td><td><span className={`badge badge-${s.status}`}>{s.status}</span></td><td><button className="text-button" onClick={() => selectSession(s)}>Details<Icon name="arrow" size={15}/></button></td></tr>)}</tbody></table></div> : <Empty icon="search" title="No matching classes" description="Try another subject or attendance status."/>}</> : <Empty icon="clock" title="A fresh start." description="Once your teacher confirms attendance, your class history and progress will appear here."/>}
    </>}
  </>;
}
