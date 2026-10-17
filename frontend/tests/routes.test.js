import test from 'node:test';
import assert from 'node:assert/strict';
import {canAccessRoute,homePath,navigationFor,routeForPath,returnPath} from '../src/routes.js';
const student={role:'student',managed_class_ids:[]};
const teacher={role:'teacher',managed_class_ids:[]};
const lead={role:'teacher',managed_class_ids:[1]};
const admin={role:'admin',managed_class_ids:[]};
test('roles have distinct landing pages and navigation URLs',()=>{
  assert.equal(homePath(student),'/student/attendance');assert.equal(homePath(teacher),'/teacher/dashboard');assert.equal(homePath(lead),'/teacher/dashboard');assert.equal(homePath(admin),'/admin/dashboard');
  for(const user of [student,teacher,lead,admin])for(const entry of navigationFor(user)){assert.ok(entry[3].startsWith(`/${user.role}/`));assert.ok(canAccessRoute(user,routeForPath(entry[3])));}
});
test('both teacher roles land on Overview without losing attendance deep links',()=>{
  for(const user of [teacher,lead]){
    assert.equal(returnPath(user,null),'/teacher/dashboard');
    assert.equal(navigationFor(user)[0][2],'Overview');
    assert.equal(routeForPath(homePath(user)).page,'overview');
    assert.equal(returnPath(user,'/teacher/attendance?assignment=2'),'/teacher/attendance?assignment=2');
  }
});
test('students and regular teachers cannot open management routes',()=>{
  for(const path of ['/admin/accounts','/teacher/students','/teacher/biometrics'])assert.equal(canAccessRoute(student,routeForPath(path)),false);
  assert.equal(canAccessRoute(teacher,routeForPath('/teacher/students')),false);
  assert.equal(canAccessRoute(lead,routeForPath('/teacher/students')),true);
  assert.equal(canAccessRoute(lead,routeForPath('/admin/accounts')),false);
  assert.equal(canAccessRoute(null,routeForPath('/teacher/attendance')),false);
});
test('session detail links resolve only under the correct portal',()=>{
  assert.equal(routeForPath('/teacher/history/SES-123').page,'history');
  assert.equal(routeForPath('/student/attendance/SES-123').view,'student');
  assert.equal(canAccessRoute(student,routeForPath('/teacher/history/SES-123')),false);
  assert.equal(routeForPath('/teacher/history/SES-123/extra'),undefined);
  assert.equal(routeForPath('/teacher/classes/').page,'classes');
});
test('login resumes authorized deep links and query selection',()=>{
  const wanted='/teacher/attendance?assignment=1&session=SES-123';
  assert.equal(returnPath(teacher,wanted),wanted);
  assert.equal(returnPath(student,wanted),homePath(student));
  assert.equal(returnPath(student,'/student/attendance/SES-123'),'/student/attendance/SES-123');
});
test('login return URLs reject external, unknown, and privileged destinations',()=>{
  for(const path of ['https://evil.example','//evil.example','/\\evil.example','/not-a-page','/admin/accounts',null])assert.equal(returnPath(teacher,path),homePath(teacher));
});
