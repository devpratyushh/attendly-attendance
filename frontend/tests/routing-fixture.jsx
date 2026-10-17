// In-memory router and synthetic identities. Never changes real authentication.
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import AppRoutes from '../src/AppRoutes';
import { api } from '../src/api';
import '../src/index.css';
import '../src/portal.css';
import '../src/color.css';
const people={student:{id:999994,role:'student',name:'Sample Student',roll_no:'TEST',managed_class_ids:[]},teacher:{id:999995,role:'teacher',name:'Sample Teacher',managed_class_ids:[]},lead:{id:999996,role:'teacher',name:'Sample Class Teacher',managed_class_ids:[1]},admin:{id:999997,role:'admin',name:'Sample Admin',managed_class_ids:[]}};
let managementRequests=0;
api.getAdminOverview=async()=>{managementRequests++;return{users:[],classes:[],teachers:[],assignments:[]};};
api.getStudents=async()=>[];api.getConfig=async()=>({});
api.getStudent=async()=>({consent_given:true,class_name:'Test class',photos:[]});
api.getStudentAttendance=async()=>({total_periods:1,attended_periods:1,total_sessions:1,sessions:[{session_id:'TEST-SESSION',date:'2026-10-17T00:00:00Z',periods:1,status:'present',subject_name:'Test subject',method:'manual',manual_reason:'Fixture'}]});
api.getBiometricStatus=async()=>[];
const query=new URLSearchParams(location.search);
export default function Fixture(){
  const [user,setUser]=useState(people[query.get('role') || 'student'] || null);
  const route=useLocation();const navigate=useNavigate();
  return <><div className="notice" style={{margin:16}}>ISOLATED ROUTING TEST · synthetic accounts · no login or official records are changed</div><div style={{margin:16,display:'flex',gap:8,flexWrap:'wrap'}}>{Object.keys(people).map(role=><button className="btn btn-sm btn-secondary" key={role} onClick={()=>setUser(people[role])}>Use {role} account</button>)}<button className="btn btn-sm btn-secondary" onClick={()=>setUser(null)}>Signed out</button><button className="btn btn-sm btn-secondary" onClick={()=>navigate(-1)}>Test back</button><button className="btn btn-sm btn-secondary" onClick={()=>navigate('/admin/accounts')}>Test admin route</button><button className="btn btn-sm btn-secondary" onClick={()=>navigate('/teacher/students')}>Test class management</button></div><output style={{display:'block',margin:16}}>Current route: {route.pathname}{route.search} · management requests: {managementRequests}</output><AppRoutes user={user} onLogin={setUser} onPassword={()=>{}} onSignOut={()=>setUser(null)}/></>;
}
createRoot(document.querySelector('#root')).render(<MemoryRouter initialEntries={[query.get('path') || '/admin/accounts']}><Fixture/></MemoryRouter>);
