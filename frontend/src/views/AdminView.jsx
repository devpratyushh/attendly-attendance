import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import Icon from '../components/Icon';
import Empty from '../components/Empty';
import Dialog from '../components/Dialog';
import StudentAvatar from '../components/StudentAvatar';
import ProfileCard from '../components/ProfileCard';
import BiometricManager from '../components/BiometricManager';
import ThresholdSettings from '../components/ThresholdSettings';
import ManagementDashboard from '../components/ManagementDashboard';

const titles = {
  overview: ['School overview', 'Your people, classes, and teaching community at a glance.'],
  accounts: ['People & accounts', 'Create sign-ins and keep your school community up to date.'],
  classes: ['Classes', 'Give every class a home and a teacher to guide it.'],
  subjects: ['Subject assignments', 'Connect each subject with the teacher who will take attendance.'],
  biometrics: ['Student biometrics', 'Manage enrollment photos and review student submissions.'],
  settings: ['Recognition settings', 'Fine-tune how face matches are identified for attendance.'],
};

export default function AdminView({ user, page, onNavigate }) {
  const [data, setData] = useState(null);
  const [students, setStudents] = useState([]);
  const [config, setConfig] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [modal, setModal] = useState(null);
  const [profile, setProfile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const admin = user.role === 'admin';
  const refresh = useCallback(async () => {
    const [overview, roster, settings] = await Promise.all([api.getAdminOverview(), api.getStudents(), api.getConfig()]);
    setData(overview); setStudents(roster.filter(s => admin || user.managed_class_ids.includes(s.class_id))); setConfig(settings);
  }, [admin, user.managed_class_ids]);
  useEffect(() => {
    let active = true;
    let loading = false;
    const load = async () => {
      if (loading || document.hidden) return;
      loading = true;
      try {
        const [overview, roster, settings] = await Promise.all([api.getAdminOverview(), api.getStudents(), api.getConfig()]);
        if (!active) return;
        setData(overview); setStudents(roster.filter(s => admin || user.managed_class_ids.includes(s.class_id))); setConfig(settings);
      } catch (e) { if (active) setError(e.message); }
      finally { loading = false; }
    };
    load();
    const timer = setInterval(load, 30000);
    window.addEventListener('focus', load);
    document.addEventListener('visibilitychange', load);
    return () => { active = false; clearInterval(timer); window.removeEventListener('focus', load); document.removeEventListener('visibilitychange', load); };
  }, [admin, user.managed_class_ids, page]);
  const run = async (action, message) => {
    setBusy(true); setError('');
    try { await action(); setModal(null); setNotice(message); await refresh(); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };
  if (!data) return error ? <div className="notice error" role="alert">{error}<button className="btn btn-secondary" onClick={() => refresh().catch(e => setError(e.message))}>Retry</button></div> : <div className="loading"><div className="spinner"/>Loading your school…</div>;
  const accounts = data.users.filter(u => (filter === 'all' || u.role === filter) && `${u.name} ${u.username} ${u.roll_no || ''}`.toLowerCase().includes(search.toLowerCase()));
  const className = id => data.classes.find(c => c.id === id)?.name || '—';
  const personData = account => ({...account,...students.find(student=>student.id===account.student_id),id:account.id,role:account.role,username:account.username,class_name:className(account.class_id)});
  const [title, subtitle] = titles[page];
  const open = type => { setError(''); setModal({ type }); };
  return <>
    <div className="page-heading"><div><div className="eyebrow">{admin ? 'Administration' : 'Class management'}</div><h1>{!admin && page === 'overview' ? 'Class overview' : !admin && page === 'accounts' ? 'Your students' : title}</h1><p>{subtitle}</p></div>
      {['accounts', 'classes', 'subjects'].includes(page) && (page !== 'classes' || admin) && <button className="btn btn-primary" onClick={() => open(page === 'accounts' ? 'account' : page === 'classes' ? 'class' : 'subject')}><Icon name="plus" size={17}/>{page === 'accounts' ? 'Create account' : page === 'classes' ? 'Add class' : 'Assign subject'}</button>}
    </div>
    {error && !modal && <div className="notice error" role="alert">{error}</div>}{notice && <div className="notice success" role="status"><Icon name="check" size={17}/>{notice}</div>}
    {page === 'overview' && <ManagementDashboard data={data} students={students} admin={admin} onNavigate={onNavigate} onCreate={open}/>}
    {page === 'accounts' && <>
      <div className="table-toolbar"><label className="search-field"><span className="sr-only">Search accounts</span><input placeholder="Search by name, username, or roll number…" value={search} onChange={e => setSearch(e.target.value)}/></label>{admin && <select aria-label="Filter accounts" value={filter} onChange={e => setFilter(e.target.value)}><option value="all">All people</option><option value="teacher">Teachers</option><option value="student">Students</option></select>}</div>
      {accounts.length ? <div className="table-container"><table><thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Class / roll no.</th><th className="align-right">Actions</th></tr></thead><tbody>{accounts.map(u => <tr key={u.id}><td><button className="person-cell person-profile-button" aria-label={`View profile of ${u.name}`} onClick={()=>setProfile(personData(u))}><StudentAvatar student={personData(u)} size={38}/><span><strong>{u.name}</strong><small>View profile</small></span></button></td><td>{u.username}</td><td><span className="badge neutral">{u.role === 'teacher' && u.managed_class_ids.length ? 'Class teacher' : u.role}</span></td><td>{u.role === 'student' ? <>{className(u.class_id)}<span className="cell-subtext">{u.roll_no}</span></> : u.managed_class_ids.map(className).join(', ') || '—'}</td><td><div className="row-actions"><button className="icon-button" title={`Reset password for ${u.name}`} aria-label={`Reset password for ${u.name}`} onClick={() => { setError(''); setModal({ type: 'reset', account: u }); }}><Icon name="key" size={17}/></button><button className="icon-button danger-text" title={`Remove ${u.name}`} aria-label={`Remove ${u.name}`} onClick={() => { setError(''); setModal({ type: 'delete', account: u }); }}><Icon name="trash" size={17}/></button></div></td></tr>)}</tbody></table></div> : <Empty icon="users" title={search ? 'No matching people.' : 'Good things start with people.'} description={search ? 'Try another name, username, or roll number.' : 'Create an account and share the sign-in details with its owner.'} action={() => open('account')} actionLabel="Create an account"/>}
    </>}
    {page === 'classes' && (data.classes.length ? <div className="class-grid">{data.classes.map(c => <div className="card class-card" key={c.id}><div className="flex justify-between items-center"><span className="soft-icon"><Icon name="school"/></span><span className="badge neutral">{c.student_count} students</span></div><h2 className="mt-4">{c.name}</h2><p className="text-muted text-sm mt-2">{data.assignments.filter(a => a.class_id === c.id).length} subjects assigned</p><div className="class-teacher-block"><span className="eyebrow">Class teacher</span><p>{data.teachers.find(t => t.id === c.class_teacher_id)?.name || 'Not yet appointed'}</p></div>{admin && <button className="btn btn-secondary btn-full" onClick={() => { setError(''); setModal({ type: 'class', classroom: c }); }}>Edit class & appointment</button>}</div>)}</div> : <Empty icon="school" title="A home for every student." description="Create your first class, then appoint a class teacher to manage it." action={admin ? () => open('class') : undefined} actionLabel="Add class"/>)}
    {page === 'subjects' && (data.assignments.length ? <div className="table-container"><table><thead><tr><th>Subject</th><th>Class</th><th>Assigned teacher</th><th className="align-right">Actions</th></tr></thead><tbody>{data.assignments.map(a => <tr key={a.id}><td><strong>{a.subject_name}</strong><span className="cell-subtext">{a.subject_code}</span></td><td>{a.class_name}</td><td>{a.teacher_name}</td><td><div className="row-actions"><button className="btn btn-sm btn-secondary" onClick={() => { setError(''); setModal({ type: 'subject', assignment: a }); }}>Reassign</button><button className="icon-button danger-text" aria-label={`Remove ${a.subject_name}`} onClick={() => { setError(''); setModal({ type: 'deleteSubject', assignment: a }); }}><Icon name="trash" size={17}/></button></div></td></tr>)}</tbody></table></div> : <Empty icon="book" title="The right teacher for every subject." description="Create a class and teacher accounts, then connect them with a subject." action={() => open('subject')} actionLabel="Assign a subject"/>)}
    {page === 'biometrics' && (students.length ? <BiometricManager students={students} onRefresh={() => refresh().catch(e => setError(e.message))}/> : <Empty icon="face" title="Ready when your students are." description="Add student accounts first. Students can submit their photos after giving consent."/>)}
    {page === 'settings' && <div className="narrow-panel"><ThresholdSettings config={config}/></div>}
    {profile && <Dialog title="Profile" onClose={()=>setProfile(null)}><ProfileCard person={profile} roleLabel={profile.role==='teacher' && profile.managed_class_ids?.length ? 'Class teacher' : profile.role}/></Dialog>}
    {modal && <Dialog title={modal.type === 'account' ? 'Create an account' : modal.type === 'class' ? (modal.classroom ? 'Edit class' : 'Add a class') : modal.type === 'subject' ? (modal.assignment ? 'Reassign subject' : 'Assign a subject') : modal.type === 'reset' ? 'Reset account password' : modal.type === 'deleteSubject' ? 'Remove subject assignment?' : 'Remove this account?'} onClose={() => { if (!busy) { setModal(null); setError(''); } }}>
      {modal.type === 'account' && <AccountForm admin={admin} classes={data.classes} busy={busy} onSubmit={values => run(() => api.createUser(values), 'Account created. Share the username and password with its owner.')}/>}
      {modal.type === 'class' && <form onSubmit={e => { e.preventDefault(); const values = Object.fromEntries(new FormData(e.currentTarget)); values.class_teacher_id = Number(values.class_teacher_id) || null; run(() => modal.classroom ? api.updateClass(modal.classroom.id, values) : api.createClass(values), 'Class saved.'); }}><label className="field">Class name<input name="name" placeholder="e.g. Grade 10 · Section A" defaultValue={modal.classroom?.name} required maxLength={100}/></label><label className="field">Class teacher<select name="class_teacher_id" defaultValue={modal.classroom?.class_teacher_id || ''}><option value="">Appoint later</option>{data.teachers.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label><p className="form-hint">The class teacher can manage this class’s students, review biometrics, and assign subjects to teachers.</p><button className="btn btn-primary btn-full" disabled={busy}>{busy ? 'Saving…' : 'Save class'}</button></form>}
      {modal.type === 'subject' && <form onSubmit={e => { e.preventDefault(); const values = Object.fromEntries(new FormData(e.currentTarget)); values.class_id = Number(values.class_id); values.teacher_id = Number(values.teacher_id); run(() => modal.assignment ? api.updateAssignment(modal.assignment.id, { ...modal.assignment, ...values }) : api.createAssignment(values), 'Subject assignment saved.'); }}>
        {!modal.assignment && <><label className="field">Subject name<input name="subject_name" placeholder="e.g. Mathematics" maxLength={100} required/></label><label className="field">Subject code<input name="subject_code" placeholder="e.g. MAT101" maxLength={30} required/></label><label className="field">Class<select name="class_id" required defaultValue=""><option value="" disabled>Select a class</option>{data.classes.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label></>}
        {modal.assignment && <p className="form-hint">{modal.assignment.subject_name} · {modal.assignment.class_name}</p>}<label className="field">Teacher<select name="teacher_id" defaultValue={modal.assignment?.teacher_id || ''} required><option value="" disabled>Select a teacher</option>{data.teachers.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label><button className="btn btn-primary btn-full" disabled={busy || !data.teachers.length || !data.classes.length}>{busy ? 'Saving…' : 'Save assignment'}</button>{(!data.teachers.length || !data.classes.length) && <p className="form-hint">Create at least one teacher account and class first.</p>}</form>}
      {modal.type === 'reset' && <form onSubmit={e => { e.preventDefault(); const password = new FormData(e.currentTarget).get('password'); run(() => api.resetPassword(modal.account.id, password), 'Password reset. Share the new password with its owner.'); }}><p className="form-hint">Set a new password for {modal.account.name}. They will need to sign in again.</p><label className="field">New password<input name="password" type="password" minLength={8} autoComplete="new-password" required/></label><button className="btn btn-primary btn-full" disabled={busy}>{busy ? 'Resetting…' : 'Reset password'}</button></form>}
      {modal.type === 'delete' && <><p className="form-hint">Remove {modal.account.name}’s account? {modal.account.role === 'student' ? 'Their attendance records and enrolled biometric data will also be deleted.' : 'Reassign their subjects and class responsibilities before removing them.'}</p><div className="dialog-actions"><button className="btn btn-secondary" disabled={busy} onClick={() => setModal(null)}>Keep account</button><button className="btn btn-danger" disabled={busy} onClick={() => run(() => api.deleteUser(modal.account.id), 'Account removed.')}>{busy ? 'Removing…' : 'Remove account'}</button></div></>}
      {modal.type === 'deleteSubject' && <><p className="form-hint">Remove {modal.assignment.subject_name} from {modal.assignment.class_name}? Subjects with attendance history must be reassigned instead.</p><div className="dialog-actions"><button className="btn btn-secondary" onClick={() => setModal(null)}>Cancel</button><button className="btn btn-danger" disabled={busy} onClick={() => run(() => api.deleteAssignment(modal.assignment.id), 'Subject assignment removed.')}>Remove assignment</button></div></>}
      {error && <div className="notice error mt-3" role="alert">{error}</div>}
    </Dialog>}
  </>;
}

function AccountForm({ admin, classes, busy, onSubmit }) {
  const [role, setRole] = useState(admin ? 'teacher' : 'student');
  return <form onSubmit={e => { e.preventDefault(); const data = Object.fromEntries(new FormData(e.currentTarget)); data.role = role; data.class_id = Number(data.class_id) || null; onSubmit(data); }}>
    {admin && <label className="field">Account type<select value={role} onChange={e => setRole(e.target.value)}><option value="teacher">Teacher</option><option value="student">Student</option></select></label>}
    <label className="field">Full name<input name="name" placeholder="Enter full name" maxLength={100} required/></label>
    {role === 'student' && <div className="form-two-columns"><label className="field">Roll number<input name="roll_no" placeholder="e.g. STU001" maxLength={20} pattern="[A-Za-z0-9_-]+" required/></label><label className="field">Class<select name="class_id" defaultValue="" required><option value="" disabled>Select class</option>{classes.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label></div>}
    <label className="field">Username<input name="username" placeholder="Choose a unique username" minLength={3} maxLength={80} pattern="[A-Za-z0-9_.-]+" autoComplete="off" required/></label><label className="field">Initial password<input name="password" type="password" placeholder="At least 8 characters" minLength={8} autoComplete="new-password" required/></label><p className="form-hint">Share these details with the account owner. They can change their password after signing in.</p><button className="btn btn-primary btn-full" disabled={busy || (role === 'student' && !classes.length)}>{busy ? 'Creating…' : 'Create account'}</button>{role === 'student' && !classes.length && <p className="form-hint">Create a class before adding students.</p>}
  </form>;
}
