// UI-only synthetic records. No authentication changes or database writes.
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import WorkspaceShell from '../src/components/WorkspaceShell';
import StudentView from '../src/views/StudentView';
import ManagementDashboard from '../src/components/ManagementDashboard';
import BiometricManager from '../src/components/BiometricManager';
import { api } from '../src/api';
import '../src/index.css';
import '../src/portal.css';
import '../src/color.css';
const role = new URLSearchParams(location.search).get('role') === 'teacher' ? 'teacher' : 'student';
const user = {id:999993,name:role==='student'?'Alex Morgan':'Jordan Taylor',role,roll_no:'TEST-001',managed_class_ids:role==='teacher'?[1]:[]};
const sessions = Array.from({length:10},(_,i)=>({session_id:`UI-FIXTURE-${i}`,date:new Date(2026,9,1+i).toISOString(),periods:i%3===0?2:1,status:i===2||i===7?'absent':'present',subject_name:i%2?'Applied Mathematics':'Computer Science',subject_code:i%2?'MAT101':'CS101',method:'manual',manual_reason:'Synthetic UI fixture'}));
const total = sessions.reduce((n,s)=>n+s.periods,0);
api.getStudent = async()=>({...user,consent_given:true,class_name:'Computer Science · Year 2',photos:[],has_embeddings:true});
api.getStudentAttendance = async()=>({sessions,total_periods:total,attended_periods:total-2,total_sessions:sessions.length});
const students=Array.from({length:6},(_,i)=>({id:i,name:['Alex Morgan','Sam Taylor','Jamie Lee','Robin Patel','Casey Chen','Avery Singh'][i],roll_no:`TEST-${i+1}`,photos:i===0?[{type:'front',url:'/tests/missing-avatar.jpg'}]:[],consent_given:i!==5,has_embeddings:i<4}));
api.getPendingBiometrics = async()=>[];
api.getBiometricLogs = async()=>[];
const data={class_attendance:[{class_id:1,date:"2026-10-17T09:00:00Z",attended:9,total:14}],classes:[{id:1,name:'Computer Science · Year 2',student_count:6,class_teacher_id:1}],teachers:[{id:1,name:user.name}],assignments:[{id:1,class_id:1,class_name:'Computer Science · Year 2',subject_name:'Applied Mathematics',subject_code:'MAT101',teacher_name:user.name}]};
export default function Fixture() {
  const [page,setPage]=useState('overview');
  useEffect(()=>{
    const measure=()=>{const workspace=document.querySelector('.workspace');const grid=document.querySelector('.stats-grid');if(!workspace || !grid)return;parent.postMessage({type:'portal-fixture-layout',role,viewport:innerWidth,scrollWidth:document.documentElement.scrollWidth,contentWidth:document.documentElement.clientWidth,accent:getComputedStyle(workspace).getPropertyValue('--accent-primary'),sidebarWidth:document.querySelector('.sidebar').getBoundingClientRect().width,columns:getComputedStyle(grid).gridTemplateColumns},location.origin);};
    const observer=new MutationObserver(measure);observer.observe(document.querySelector('#root'),{childList:true,subtree:true});window.addEventListener('resize',measure);measure();return()=>{observer.disconnect();window.removeEventListener('resize',measure);};
  },[]);
  const nav=role==='student'?[['overview','grid','My attendance'],['biometric','face','My biometrics']]:[['overview','grid','Overview'],['accounts','users','Students'],['classes','school','Classes'],['subjects','book','Subject assignments'],['biometrics','face','Biometrics'],['attendance','camera','Take attendance'],['history','clock','Session history']];
  return <WorkspaceShell user={user} roleLabel={role==='student'?'Student':'Class teacher'} nav={nav} page={page} onNavigate={setPage} onPassword={()=>{}} onSignOut={()=>{}}><div className="text-xs text-muted" style={{marginBottom:18}}>ISOLATED UI FIXTURE · synthetic records · nothing is saved</div>{role==='student'?<StudentView user={user} page={page}/>:page==='overview'?<><div className="page-heading"><div><div className="eyebrow">Class management</div><h1>Class overview</h1><p>Your people, classes, and teaching community at a glance.</p></div></div><ManagementDashboard data={data} students={students} admin={false} onNavigate={setPage} onCreate={()=>{}}/></>:page==="biometrics"?<BiometricManager students={students} onRefresh={async()=>{}}/>:<div className="card">Navigation test: {page}</div>}</WorkspaceShell>;
}
createRoot(document.querySelector('#root')).render(<Fixture/>);
