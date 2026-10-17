// Synthetic submissions and simulated decisions only. No server calls or writes.
import { createRoot } from 'react-dom/client';
import BiometricManager from '../src/components/BiometricManager';
import { api } from '../src/api';
import '../src/index.css';
import '../src/portal.css';
import '../src/color.css';
const url='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 120"><rect width="100" height="120" fill="#e5f0e9"/><circle cx="50" cy="42" r="22" fill="#9db5a6"/><path d="M15 120V97a35 35 0 0 1 70 0v23" fill="#9db5a6"/></svg>');
const students=Array.from({length:9},(_,i)=>({id:i+1,name:`Sample Student ${i+1}`,roll_no:`TEST-${i+1}`,photos:[{type:'front',url}],consent_given:true}));
let photos=students.flatMap(s=>['front','left','right'].map((type,i)=>({id:s.id*10+i,student_id:s.id,name:s.name,roll_no:s.roll_no,photo_type:type,url,submitted_at:'2026-10-17T06:00:00Z',validation:{status:i===1?'needs_retake':'ready',message:i===1?'A clearer side view is needed.':'One clear face detected.'}})));
api.getPendingBiometrics=async()=>photos;
api.approveBiometric=async id=>{photos=photos.filter(p=>p.id!==id);return{};};
api.rejectBiometric=async id=>{photos=photos.filter(p=>p.id!==id);return{};};
createRoot(document.querySelector('#root')).render(<div className="role-teacher" style={{maxWidth:1050,margin:'auto',padding:20}}><div className="notice">UI PREVIEW · sample submissions · no real records are changed</div><BiometricManager students={students} onRefresh={async()=>{}}/></div>);
