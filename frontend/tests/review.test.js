import test from 'node:test';
import assert from 'node:assert/strict';
import { attendanceStatus, confirmationRecords, reviewReason, reviewRemaining, photoEvidence } from '../src/offline/review.js';
import { latestBiometricUpdates } from '../src/offline/biometrics.js';

test('a previous biometric rejection cannot mask a new pending submission',()=>{
  const updates=[{id:1,photo_type:'front',status:'rejected',submitted_at:'2026-10-16T10:00:00Z'},
    {id:4,photo_type:'front',status:'pending',submitted_at:'2026-10-17T10:00:00Z'},
    {id:2,photo_type:'left',status:'approved',submitted_at:'2026-10-16T10:00:00Z'},
    {id:3,photo_type:'right',status:'approved',submitted_at:'2026-10-16T10:00:00Z'}];
  const latest=latestBiometricUpdates(updates);
  assert.equal(latest.length,3);
  assert.equal(latest.find(p=>p.photo_type==='front').status,'pending');
  assert.equal(latest.filter(p=>p.status==='rejected').length,0);
  assert.equal(updates[0].status,'rejected');
});

test('bulk absence preserves confident matches and previous manual decisions', () => {
  const rows = [{student_id:1,status:'matched'}, {student_id:2,status:'unresolved'}, {student_id:3,status:'unresolved'}, {student_id:4,status:'matched'}];
  const overrides = {2:{status:'present',reason:'Seen in class'}, 4:{status:'absent',reason:'Teacher correction'}};
  const next = reviewRemaining(rows, overrides);
  assert.deepEqual(overrides, {2:{status:'present',reason:'Seen in class'},4:{status:'absent',reason:'Teacher correction'}});
  assert.deepEqual(rows.map(row=>attendanceStatus(row,next)), ['present','present','absent','absent']);
  assert.equal(next[3].reason, reviewReason('absent'));
  assert.deepEqual(reviewRemaining(rows,next), next);
  const records=confirmationRecords(rows,next);
  assert.equal(records[0].method,'auto');
  assert.equal(records[2].method,'manual');
  assert.equal(records[2].manual_reason,reviewReason('absent'));
});

test('missing detection never silently becomes absence; undo requires review again', () => {
  const rows=[{student_id:1,status:'unresolved'}];
  assert.throws(()=>confirmationRecords(rows,{}), /Review/);
  assert.equal(confirmationRecords(rows,reviewRemaining(rows,{}))[0].status,'absent');
  const undone=reviewRemaining(rows,{}); delete undone[1];
  assert.throws(()=>confirmationRecords(rows,undone), /Review/);
  assert.throws(()=>confirmationRecords([],{}), /Review/);
});

test('local images recover face geometry by receipt, client request ID, or content hash', () => {
  const a={id:12,client_photo_id:'job_0',content_hash:'hash-a',width:2560,height:1440,detections:[{bbox:[100,200,300,400],label:'Student',status:'matched'}]};
  const b={id:13,client_photo_id:'job_1',content_hash:'hash-b',detections:[]};
  const analysis={photos:[a,b]};
  assert.equal(photoEvidence({id:'job:0',client_photo_id:'job_0'},analysis),a);
  assert.equal(photoEvidence({id:'job:1',server_photo_id:13},analysis),b);
  assert.equal(photoEvidence({id:'duplicate:0',content_hash:'hash-a'},analysis),a);
  assert.equal(photoEvidence({id:12},analysis),a);
  assert.equal(photoEvidence({id:'unuploaded:0'},analysis),undefined);
});
