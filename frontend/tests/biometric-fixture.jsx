// Synthetic status and a controlled camera promise. Never opens a real camera,
// signs in, uploads photographs, or modifies application storage.
import { createRoot } from 'react-dom/client';
import UpdateBiometric from '../src/components/UpdateBiometric';
import { api } from '../src/api';
import '../src/index.css';
import '../src/portal.css';
import '../src/color.css';
let resolveCamera;
let stopped=0;
const output=document.createElement('output');output.id='camera-check';output.style.display='block';output.style.padding='15px';document.body.prepend(output);
const release=document.createElement('button');release.textContent='Resolve cancelled camera request';release.className='btn btn-secondary';release.onclick=()=>{resolveCamera?.({getTracks:()=>[{stop:()=>{stopped++;output.textContent=`Stopped late camera tracks: ${stopped}`;}}]});};document.body.prepend(release);
Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia:()=>new Promise(resolve=>{resolveCamera=resolve;output.textContent='Camera loading; no frame is ready';})}});
api.getBiometricStatus=async()=>[
  {id:1,photo_type:'front',status:'rejected',submitted_at:'2026-10-16T00:00:00Z'},
  {id:2,photo_type:'front',status:'pending',submitted_at:'2026-10-17T00:00:00Z',validation:{status:'needs_retake',message:'Face is blurred.'}},
  {id:3,photo_type:'left',status:'pending',submitted_at:'2026-10-17T00:00:00Z'},
  {id:4,photo_type:'right',status:'pending',submitted_at:'2026-10-17T00:00:00Z'}];
api.submitBiometricUpdate=async()=>{throw new Error('This isolated fixture cannot upload.');};
createRoot(document.querySelector('#root')).render(<div className="role-student" style={{maxWidth:650,padding:20,margin:'auto'}}><div className="notice">ISOLATED FIXTURE · simulated statuses and camera · nothing is saved</div><UpdateBiometric student={{roll_no:'TEST-ONLY',consent_given:true}}/></div>);
