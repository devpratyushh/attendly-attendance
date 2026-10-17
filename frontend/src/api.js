const API_BASE = '';

async function request(url, options = {}) {
  const res = await fetch(`${API_BASE}${url}`, { credentials: 'include', ...options });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    if (res.status === 401 && !url.includes('/auth/login')) window.dispatchEvent(new Event('auth-expired'));
    const detail = err.detail;
    const error = new Error(typeof detail === 'string' ? detail : Array.isArray(detail) ? detail.map(item => item.msg).join('. ') : detail?.message || 'The request could not be completed. Please try again.');
    error.status = res.status; throw error;
  }
  return res.json();
}

export const api = {
  me: () => request('/api/auth/me'),
  login: data => request('/api/auth/login', jsonOptions('POST', data)),
  logout: () => request('/api/auth/logout', { method: 'POST' }),
  changePassword: data => request('/api/auth/password', jsonOptions('POST', data)),
  getAdminOverview: () => request('/api/admin/overview'),
  createUser: data => request('/api/admin/users', jsonOptions('POST', data)),
  deleteUser: id => request(`/api/admin/users/${id}`, { method: 'DELETE' }),
  resetPassword: (id, password) => request(`/api/admin/users/${id}/password`, jsonOptions('POST', { password })),
  createClass: data => request('/api/admin/classes', jsonOptions('POST', data)),
  updateClass: (id, data) => request(`/api/admin/classes/${id}`, jsonOptions('PUT', data)),
  createAssignment: data => request('/api/admin/assignments', jsonOptions('POST', data)),
  updateAssignment: (id, data) => request(`/api/admin/assignments/${id}`, jsonOptions('PUT', data)),
  deleteAssignment: id => request(`/api/admin/assignments/${id}`, { method: 'DELETE' }),
  getAssignments: () => request('/api/assignments'),
  // Config
  getConfig: () => request('/api/config'),
  updateThresholds: (match, uncertain, margin) => {
    const fd = new FormData();
    fd.append('match_threshold', match);
    fd.append('uncertain_threshold', uncertain);
    fd.append('min_match_margin', margin ?? 0.08);
    return request('/api/config/thresholds', { method: 'POST', body: fd });
  },
  activateCalibration: report => {
    const fd = new FormData();
    fd.append('report', report);
    return request('/api/config/calibration', { method: 'POST', body: fd });
  },

  // Students
  getStudents: classId => request(`/api/students${classId ? `?class_id=${classId}` : ''}`),
  getStudent: (rollNo) => request(`/api/students/${rollNo}`),
  getStudentAttendance: (rollNo) => request(`/api/students/${rollNo}/attendance`),
  giveConsent: (rollNo) => request(`/api/students/${rollNo}/consent`, { method: 'POST' }),

  // Biometric update (student)
  getBiometricGuide: (rollNo, frame, signal) => {
    const body = new FormData();
    body.append('photo', frame, 'preview.jpg');
    return request(`/api/students/${rollNo}/biometric/guide`, { method: 'POST', body, signal });
  },
  submitBiometricUpdate: (rollNo, frontFile, leftFile, rightFile) => {
    const fd = new FormData();
    fd.append('front', frontFile);
    fd.append('left', leftFile);
    fd.append('right', rightFile);
    return request(`/api/students/${rollNo}/biometric/update`, { method: 'POST', body: fd });
  },
  getBiometricStatus: (rollNo) => request(`/api/students/${rollNo}/biometric/status`),

  // Sessions
  createSession: (periods, assignmentId) => {
    const fd = new FormData();
    fd.append('periods', periods);
    fd.append('assignment_id', assignmentId);
    return request('/api/sessions/create', { method: 'POST', body: fd });
  },
  uploadClassPhoto: (sessionId, photoFile) => {
    const fd = new FormData();
    fd.append('photo', photoFile);
    return request(`/api/sessions/${sessionId}/upload`, { method: 'POST', body: fd });
  },
  confirmSession: (sessionId, records, periods) => {
    const fd = new FormData();
    fd.append('records', JSON.stringify(records));
    if (periods != null) fd.append('periods', periods);
    return request(`/api/sessions/${sessionId}/confirm`, { method: 'POST', body: fd });
  },
  getSessions: () => request('/api/sessions'),
  getSession: (sessionId) => request(`/api/sessions/${sessionId}`),
  getSessionAnalysis: sessionId => request(`/api/sessions/${sessionId}/analysis`),
  exportSessionCsvUrl: (sessionId) => `/api/sessions/${sessionId}/export`,

  // Biometrics (teacher)
  getPendingBiometrics: () => request('/api/biometrics/pending'),
  approveBiometric: (id) => request(`/api/biometrics/pending/${id}/approve`, { method: 'POST' }),
  rejectBiometric: (id, reason) => { const body=new FormData(); if(reason) body.append('reason',reason); return request(`/api/biometrics/pending/${id}/reject`, { method: 'POST', body }); },
  teacherUploadPhoto: (studentId, photoType, photoFile) => {
    const fd = new FormData();
    fd.append('photo_type', photoType);
    fd.append('photo', photoFile);
    return request(`/api/biometrics/${studentId}/upload`, { method: 'POST', body: fd });
  },
  deletePhoto: (studentId, photoType) =>
    request(`/api/biometrics/${studentId}/photos/${photoType}`, { method: 'DELETE' }),
  getBiometricLogs: (studentId) =>
    request(`/api/biometrics/logs${studentId ? `?student_id=${studentId}` : ''}`),

  // Stats
  getOverview: () => request('/api/stats/overview'),
};

function jsonOptions(method, data) {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) };
}
