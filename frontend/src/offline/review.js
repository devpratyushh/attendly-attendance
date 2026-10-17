export const reviewReason = status => status === 'present' ? 'Teacher verified this student in class.' : 'Teacher checked the class roster and confirmed absence.';
export function photoEvidence(photo, analysis) {
  return analysis?.photos?.find(item => item.id === photo.server_photo_id || item.id === photo.id ||
    (photo.client_photo_id && item.client_photo_id === photo.client_photo_id) ||
    (photo.content_hash && item.content_hash === photo.content_hash));
}
export const attendanceStatus = (row, overrides) => overrides[row.student_id]?.status || (row.status === 'matched' ? 'present' : 'unresolved');
export function reviewRemaining(rows, overrides, reason = reviewReason('absent')) {
  const next = { ...overrides };
  for (const row of rows) if (attendanceStatus(row, overrides) === 'unresolved') next[row.student_id] = { status: 'absent', reason };
  return next;
}
export function confirmationRecords(rows, overrides) {
  if (!rows.length || rows.some(row => attendanceStatus(row, overrides) === 'unresolved')) throw new Error('Review the remaining students before confirming.');
  return rows.map(row => ({ student_id: row.student_id, status: attendanceStatus(row, overrides),
    method: overrides[row.student_id] ? 'manual' : 'auto', manual_reason: overrides[row.student_id]?.reason || '' }));
}
