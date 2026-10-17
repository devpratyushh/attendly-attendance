// Synthetic profiles only; no real login, media, or official records are changed.
import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import WorkspaceShell from '../src/components/WorkspaceShell';
import AdminView from '../src/views/AdminView';
import { api } from '../src/api';
import '../src/index.css';import '../src/portal.css';import '../src/color.css';
const canvas=document.createElement('canvas');canvas.width=200;canvas.height=200;
const ctx=canvas.getContext('2d');ctx.fillStyle='#dce9e4';ctx.fillRect(0,0,200,200);ctx.fillStyle='#799c8e';ctx.beginPath();ctx.arc(100,80,35,0,Math.PI*2);ctx.fill();ctx.beginPath();ctx.arc(100,190,70,Math.PI,0);ctx.fill();
const photo=canvas.toDataURL('image/png');
const students=[{id:1,name:'Alex Morgan',roll_no:'ST001',class_id:1,email:'',consent_given:true,has_embeddings:true,photos:[{type:'front',url:photo}]},{id:2,name:'Sam Taylor',roll_no:'ST002',class_id:1,consent_given:false,has_embeddings:false,photos:[]}];
const users=students.map(s=>({id:s.id+10,student_id:s.id,name:s.name,username:s.name.split(' ')[0].toLowerCase(),role:'student',roll_no:s.roll_no,class_id:1,managed_class_ids:[]}));
api.getAdminOverview=async()=>({users,classes:[{id:1,name:'Computer Science',student_count:2}],teachers:[],assignments:[]});api.getStudents=async()=>students;api.getConfig=async()=>({});
const user={id:999990,name:'Jordan Taylor',username:'jordan',role:'teacher',managed_class_ids:[1]};
export default function Fixture(){const [page,setPage]=useState('accounts');return <WorkspaceShell user={user} roleLabel="Class teacher" nav={[['accounts','users','Students']]} page={page} onNavigate={setPage} onPassword={()=>{}} onSignOut={()=>{}}><p className="notice">ISOLATED UI PREVIEW · synthetic profiles and illustration</p><AdminView user={user} page={page}/></WorkspaceShell>;}
createRoot(document.querySelector('#root')).render(<Fixture/>);
