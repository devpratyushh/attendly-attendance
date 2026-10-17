// Synthetic classroom illustration; no authentication, personal images, or API calls.
import { createRoot } from 'react-dom/client';
import SessionDetail from '../src/components/SessionDetail';
import '../src/index.css';
import '../src/portal.css';
import '../src/color.css';
const canvas=document.createElement('canvas');canvas.width=1000;canvas.height=420;
const ctx=canvas.getContext('2d');ctx.fillStyle='#e7e8ef';ctx.fillRect(0,0,1000,420);
ctx.fillStyle='#cac6db';ctx.fillRect(150,60,700,200);ctx.fillStyle='#aaa2bf';ctx.fillRect(340,160,140,180);
const photo={id:1,url:canvas.toDataURL('image/jpeg'),width:1000,height:420,detections:[{bbox:[340,160,480,340],label:'Sample student',status:'matched',confidence:.86}]};
createRoot(document.querySelector('#root')).render(<main className="role-student" style={{maxWidth:new URLSearchParams(location.search).has('compact')?360:800,margin:'24px auto',padding:16}}><p className="text-xs text-muted mb-3">ISOLATED UI PREVIEW · synthetic classroom illustration</p><SessionDetail onBack={()=>{}} session={{session_id:'PREVIEW-ONLY',date:'2026-10-17T08:00:00Z',periods:1,status:'present',method:'auto',class_photos:[photo,{...photo,id:2,detections:[]}]}}/></main>);
