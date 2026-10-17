import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enrollmentStatus } from '../src/enrollment.js';

test('students without biometrics count as needing enrollment, including before consent', () => {
  assert.equal(enrollmentStatus({ has_embeddings: false, consent_given: false }), 'enrollment');
  assert.equal(enrollmentStatus({ has_embeddings: false, consent_given: true }), 'enrollment');
});

test('enrollment alone does not imply consent or readiness', () => {
  assert.equal(enrollmentStatus({ has_embeddings: true, consent_given: false }), 'consent');
  assert.equal(enrollmentStatus({ has_embeddings: true, consent_given: true }), 'ready');
});

test('two enrolled students and one unenrolled student produce 67% readiness', () => {
  const roster = [{ has_embeddings: true, consent_given: true }, { has_embeddings: true, consent_given: true }, { has_embeddings: false, consent_given: false }];
  const counts = roster.reduce((result, student) => { result[enrollmentStatus(student)]++; return result; }, { ready: 0, consent: 0, enrollment: 0 });
  assert.deepEqual(counts, { ready: 2, consent: 0, enrollment: 1 });
  assert.equal(Math.round(counts.ready / roster.length * 100), 67);
});
