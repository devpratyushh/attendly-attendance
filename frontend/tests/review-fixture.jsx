// Explicitly simulated review UI: no recognition, uploads, or official records.
import React from 'react';
import { createRoot } from 'react-dom/client';
import TakeAttendance from '../src/components/TakeAttendance';
import { api } from '../src/api';
import '../src/index.css';
import '../src/portal.css';
import '../src/color.css';
const canvas = document.createElement('canvas'); canvas.width = 800; canvas.height = 400;
const ctx = canvas.getContext('2d'); ctx.fillStyle = '#e8eee9'; ctx.fillRect(0,0,800,400); ctx.fillStyle = '#b4c7bd'; ctx.fillRect(200,80,160,220);
const url = canvas.toDataURL('image/jpeg');
const photo = {id:1,url,width:800,height:400,detections:[{bbox:[200,80,360,300],label:'Clear match',status:'matched',confidence:.86}]};
const results = [{student_id:1,name:'Clear match',roll_no:'TEST01',status:'matched',confidence:.86,support_count:1,reasons:[]},
  {student_id:2,name:'Unclear student',roll_no:'TEST02',status:'unresolved',support_count:0,reasons:['ambiguous_identity']},
  {student_id:3,name:'Missing student',roll_no:'TEST03',status:'unresolved',support_count:0,reasons:['not_detected']}];
api.getSessionAnalysis = async () => ({results,photos:[photo],photo_count:1});
api.confirmSession = async () => { throw new Error('This test page cannot finalize real attendance.'); };
createRoot(document.querySelector('#root')).render(<div className="role-teacher" style={{maxWidth:750,margin:'20px auto',padding:16}}><div className="notice">ISOLATED UI FIXTURE · simulated detections · no real attendance is saved</div><TakeAttendance owner={999992} assignmentId={-1} assignmentLabel="Isolated UI fixture" initialSession={new URLSearchParams(location.search).has('capture') ? undefined : {session_id:'TEST-UI-ONLY',periods:1,photos:[photo]}} onOpenJob={()=>{}}/></div>);
