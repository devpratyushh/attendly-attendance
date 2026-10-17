import { lazy, Suspense, useEffect } from 'react';
import { Navigate, Outlet, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';
import Login from './views/Login';
import WorkspaceShell from './components/WorkspaceShell';
import { canAccessRoute, homePath, isManager, navigationFor, portalRoutes, returnPath } from './routes';
const AdminView=lazy(()=>import('./views/AdminView'));
const TeacherView=lazy(()=>import('./views/TeacherView'));
const StudentView=lazy(()=>import('./views/StudentView'));

function RequireUser({user}) {
  const location=useLocation();
  if(user)return <Outlet/>;
  const portal=['teacher','admin','student'].find(role=>location.pathname.startsWith(`/${role}/`)) || 'student';
  return <Navigate to={`/login/${portal}`} replace state={{from:location.pathname+location.search}}/>;
}
function LoginPage({user,onLogin}) {
  const {portal}=useParams();const location=useLocation();const navigate=useNavigate();
  useEffect(()=>{document.title=`${portal ? portal[0].toUpperCase()+portal.slice(1) : 'Portal'} sign in · Attendly`;},[portal]);
  if(user)return <Navigate to={returnPath(user,location.state?.from)} replace/>;
  if(!['student','teacher','admin'].includes(portal))return <Navigate to="/login/student" replace/>;
  return <Login portal={portal} onPortalChange={next=>navigate(`/login/${next}`,{replace:true,state:location.state})} onLogin={value=>{onLogin(value);navigate(returnPath(value,location.state?.from),{replace:true});}}/>;
}
function WorkspacePage({user,entry,onPassword,onSignOut}) {
  const navigate=useNavigate();const location=useLocation();const {sessionId}=useParams();
  const nav=navigationFor(user);const allowed=canAccessRoute(user,entry);
  const onNavigate=page=>{const target=nav.find(([id])=>id===page);if(target)navigate(target[3]);};
  useEffect(()=>{document.title=`${!entry?'Page not found':!allowed?'Access restricted':entry.label || (sessionId?'Session details':'Attendance')} · Attendly`;},[entry,sessionId,allowed]);
  useEffect(()=>{window.scrollTo(0,0);},[location.pathname]);
  const roleLabel=user.role==='admin'?'Administrator':user.role==='student'?'Student':isManager(user)?'Class teacher':'Teacher';
  const management=entry?.view==='management' || (entry?.path==='/teacher/dashboard' && isManager(user));
  return <WorkspaceShell user={user} roleLabel={roleLabel} nav={nav} page={allowed?entry.page:''} onNavigate={onNavigate} onPassword={onPassword} onSignOut={onSignOut}>
    {!entry || !allowed ? <div className="card"><h1>{entry?'Access restricted':'Page not found'}</h1><p className="form-hint mt-3">{entry?'This page is not available for your account.':'Check the address or return to your workspace.'}</p><button className="btn btn-primary" onClick={()=>navigate(homePath(user),{replace:true})}>Go to my workspace</button></div> : <Suspense fallback={<div className="loading"><div className="spinner"/>Loading workspace…</div>}>
      {entry.view==='student'?<StudentView key={entry.page} user={user} page={entry.page} selectedSessionId={sessionId} onSelectSession={session=>navigate(`/student/attendance/${encodeURIComponent(session.session_id)}`)} onBack={()=>navigate('/student/attendance')}/>:management?<AdminView key={entry.page} user={user} page={entry.page} onNavigate={onNavigate}/>:<TeacherView user={user} page={entry.page} onNavigate={onNavigate} historySessionId={sessionId}/>}
    </Suspense>}
  </WorkspaceShell>;
}
export default function AppRoutes({user,onLogin,onPassword,onSignOut}) {
  return <Routes>
    <Route path="/login" element={<Navigate to="/login/student" replace/>}/>
    <Route path="/login/:portal" element={<LoginPage user={user} onLogin={onLogin}/>}/>
    <Route element={<RequireUser user={user}/> }>
      <Route path="/" element={<Navigate to={homePath(user)} replace/>}/>
      {portalRoutes.map(entry=><Route key={entry.path} path={entry.path} element={<WorkspacePage user={user} entry={entry} onPassword={onPassword} onSignOut={onSignOut}/>}/>)}
      <Route path="*" element={<WorkspacePage user={user} onPassword={onPassword} onSignOut={onSignOut}/>}/>
    </Route>
  </Routes>;
}
