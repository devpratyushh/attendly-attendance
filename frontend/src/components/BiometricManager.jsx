import React, { useState, useEffect, useRef } from 'react';
import { api } from '../api';
import StudentAvatar from './StudentAvatar';
import { enrollmentStatus, ENROLLMENT_STATUSES } from '../enrollment';

export default function BiometricManager({ students, onRefresh }) {
  const [selectedStudentId, setSelectedStudentId] = useState(null);
  const selectedStudent = students.find(s => s.id === selectedStudentId) || null;
  const [searchQuery, setSearchQuery] = useState('');
  const [pending, setPending] = useState([]);
  const [pendingSearch, setPendingSearch] = useState('');
  const [pendingPage, setPendingPage] = useState(0);
  const [reviewingId, setReviewingId] = useState(null);
  const [logs, setLogs] = useState([]);
  const [showLogs, setShowLogs] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadType, setUploadType] = useState(null);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);
  const fileInputRef = useRef(null);

  const filteredStudents = (students || []).filter(s =>
    (s.name || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
    (s.roll_no || '').toLowerCase().includes(searchQuery.toLowerCase())
  );

  useEffect(() => {
    api.getPendingBiometrics().then(setPending).catch(() => {});
  }, []);

  const loadLogs = async (studentId) => {
    try {
      const data = await api.getBiometricLogs(studentId || null);
      setLogs(data);
    } catch (e) {
      console.error(e);
    }
  };

  const handleApprove = async (id) => {
    if (reviewingId !== null) return;
    setReviewingId(id); setError(null); setSuccess(null);
    try {
      await api.approveBiometric(id);
      setPending(previous => previous.filter(photo => photo.id !== id));
      setSuccess('Biometric approved and updated!');
      try {
        const updated = await api.getPendingBiometrics();
        setPending(updated);
        await onRefresh();
      } catch {
        setSuccess('Biometric approved and saved. Refresh the page to reload the latest student details.');
      }
    } catch (e) {
      setError(e.message);
    } finally { setReviewingId(null); }
  };

  const handleReject = async (id) => {
    if (reviewingId !== null) return;
    setReviewingId(id); setError(null);
    try {
      const photo = pending.find(p=>p.id===id);
      await api.rejectBiometric(id, photo?.validation?.status === 'needs_retake' ? photo.validation.message.slice(0,200) : undefined);
      setSuccess('Biometric rejected.');
      const updated = await api.getPendingBiometrics();
      setPending(updated);
    } catch (e) {
      setError(e.message);
    } finally { setReviewingId(null); }
  };

  const handleUpload = async (file) => {
    if (!selectedStudent || !uploadType) return;
    if (!selectedStudent.consent_given) {
      setError('This student must give biometric consent in their portal first.');
      return;
    }
    setUploading(true);
    setError(null);
    try {
      await api.teacherUploadPhoto(selectedStudent.id, uploadType, file);
      setSuccess(`${uploadType} photo uploaded!`);
      await onRefresh();
      setUploadType(null);
    } catch (e) {
      setError(e.message);
    }
    setUploading(false);
  };

  const handleDelete = async (photoType) => {
    if (!selectedStudent || uploading) return;
    if (!confirm(`Delete ${photoType} photo for ${selectedStudent.name}?`)) return;
    setError(null);
    try {
      await api.deletePhoto(selectedStudent.id, photoType);
      setSuccess(`${photoType} photo deleted.`);
      onRefresh();
    } catch (e) {
      setError(e.message);
    }
  };

  // Clear messages after 3s
  useEffect(() => {
    if (success) {
      const t = setTimeout(() => setSuccess(null), 3000);
      return () => clearTimeout(t);
    }
  }, [success]);

  const pendingGroups = Object.values(pending.reduce((groups, photo) => {
    const id = photo.student_id ?? photo.roll_no;
    const group = groups[id] || { id, name: photo.name, roll_no: photo.roll_no, photos: [], flagged: 0 };
    group.photos.push(photo);
    if (photo.validation?.status === 'needs_retake') group.flagged += 1;
    groups[id] = group;
    return groups;
  }, {})).map(group=>({...group,photos:group.photos.sort((a,b)=>['front','left','right'].indexOf(a.photo_type)-['front','left','right'].indexOf(b.photo_type) || b.id-a.id)}));
  const filteredGroups = pendingGroups.filter(group=>`${group.name} ${group.roll_no}`.toLowerCase().includes(pendingSearch.toLowerCase()));
  const page = Math.min(pendingPage, Math.max(0,Math.ceil(filteredGroups.length/8)-1));
  const visibleGroups = filteredGroups.slice(page*8,(page+1)*8);


  return (
    <div>
      {error && (
        <div className="card mb-3" style={{ borderColor: 'var(--danger)' }}>
          <div className="text-sm" style={{ color: 'var(--danger)' }}> {error}</div>
        </div>
      )}
      {success && (
        <div className="card mb-3" style={{ borderColor: 'var(--success)' }}>
          <div className="text-sm" style={{ color: 'var(--success)' }}> {success}</div>
        </div>
      )}

      {/* One compact review group per student; individual photo decisions remain explicit. */}
      {pending.length > 0 && <section className="card mb-3 pending-review" aria-label="Pending biometric approvals">
        <div className="pending-review-heading"><div><h2>Pending approvals <span className="badge badge-pending">{pendingGroups.length} students</span></h2><p>{pending.length} photos · grouped by student</p></div></div>
        <label className="pending-search"><span className="sr-only">Search pending students</span><input placeholder="Find a student or roll number…" value={pendingSearch} onChange={e=>{setPendingSearch(e.target.value);setPendingPage(0);}}/></label>
        <div className="pending-student-list">{visibleGroups.map(group=><details className="pending-student" key={group.id} open={filteredGroups.length===1 ? true : undefined}>
          <summary><div className="pending-student-identity"><strong>{group.name}</strong><span>{group.roll_no} · {group.photos.length} photos{group.flagged ? ` · ${group.flagged} need attention` : ''}</span></div><div className="pending-miniatures" aria-hidden="true">{group.photos.slice(0,3).map(photo=><img key={photo.id} src={photo.url} alt=""/>)}</div><span className="pending-expand" aria-hidden="true">⌄</span></summary>
          <div className="pending-photo-grid">{group.photos.map(photo=><article className="pending-photo" key={photo.id}>
            <div className="pending-photo-heading"><strong>{photo.photo_type}</strong><span>{photo.submitted_at ? new Date(photo.submitted_at).toLocaleDateString('en-IN',{day:'numeric',month:'short'}) : ''}</span></div>
            <img src={photo.url} alt={`${photo.photo_type} submission for ${group.name}`}/>
            <div className="pending-photo-actions"><button className="btn btn-sm btn-success" disabled={reviewingId!==null} onClick={()=>handleApprove(photo.id)}>{reviewingId===photo.id ? 'Saving…' : 'Approve'}</button><button className="btn btn-sm btn-secondary danger-text" disabled={reviewingId!==null} onClick={()=>handleReject(photo.id)}>{photo.validation?.status==='needs_retake' ? 'Retake' : 'Reject'}</button></div>
            {photo.validation?.status==='needs_retake' && <span className="pending-photo-flag">Quality suggestion · you can approve</span>}
            {photo.validation && <details className="pending-quality"><summary>Quality notes</summary><p>{photo.validation.message}</p></details>}
          </article>)}</div>
        </details>)}</div>
        {!filteredGroups.length && <p className="form-hint mt-3">No pending students match your search.</p>}
        {filteredGroups.length>8 && <div className="pending-pagination"><span>{page*8+1}–{Math.min((page+1)*8,filteredGroups.length)} of {filteredGroups.length} students</span><div><button className="btn btn-sm btn-secondary" disabled={page===0} onClick={()=>setPendingPage(page-1)}>Previous</button><button className="btn btn-sm btn-secondary" disabled={(page+1)*8>=filteredGroups.length} onClick={()=>setPendingPage(page+1)}>Next</button></div></div>}
      </section>}

      {/* Student selector */}
      {!selectedStudent ? (
        <div>
          <div className="flex items-center justify-between mb-3">
            <h2>Enrollment status</h2>
            <span className="text-xs text-muted">
              {filteredStudents.length} of {students.length} students
            </span>
          </div>

          <div className="mb-3">
            <input
              type="text"
              className="form-input"
              placeholder=" Search student name or roll number..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              style={{ width: '100%' }}
            />
          </div>

          {filteredStudents.length === 0 ? (
            <div className="card text-center text-muted" style={{ padding: 24 }}>
              No students found matching "{searchQuery}"
            </div>
          ) : (
            filteredStudents.map(s => (
              <div key={s.id} className="student-row" onClick={() => { setSelectedStudentId(s.id); loadLogs(s.id); }}>
                <StudentAvatar student={s} />
                <div className="student-info">
                  <div className="student-name">{s.name}</div>
                  <div className="student-roll">{s.roll_no}</div>
                </div>
                <span className={`badge ${ENROLLMENT_STATUSES[enrollmentStatus(s)].badge}`}>
                  {ENROLLMENT_STATUSES[enrollmentStatus(s)].label}
                </span>
              </div>
            ))
          )}
        </div>
      ) : (
        <div>
          <button className="btn btn-sm btn-secondary mb-3" onClick={() => { setSelectedStudentId(null); setShowLogs(false); }}>
            ← Back
          </button>

          <div className="card mb-3">
            <div className="flex items-center gap-3 mb-3">
              <StudentAvatar student={selectedStudent} size={56} />
              <div>
                <div style={{ fontWeight: 700, fontSize: '1.1rem' }}>{selectedStudent.name}</div>
                <div className="text-sm text-muted">{selectedStudent.roll_no}</div>
              </div>
            </div>

            {!selectedStudent.consent_given && <div className="notice">Waiting for this student to give biometric consent in their portal.</div>}
            {uploading && <div className="notice" role="status">Processing enrollment photo…</div>}
            {/* Current photos */}
            <div className="card-title mb-2">Enrolled Photos</div>
            <div className="photo-grid">
              {['front', 'left', 'right'].map(type => {
                const photo = selectedStudent.photos?.find(p => p.type === type);
                return (
                  <div key={type} style={{ textAlign: 'center' }}>
                    {photo ? (
                      <>
                        <img src={photo.url} alt={type} />
                        <div className="flex gap-2 mt-2" style={{ justifyContent: 'center' }}>
                          <button
                            className="btn btn-sm btn-secondary"
                            onClick={() => { setUploadType(type); fileInputRef.current?.click(); }}
                          >
                            Replace
                          </button>
                          <button className="btn btn-sm btn-danger" onClick={() => handleDelete(type)}>
                            Remove
                          </button>
                        </div>
                      </>
                    ) : (
                      <div
                        className="upload-area"
                        style={{ aspectRatio: '1', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}
                        onClick={() => { setUploadType(type); fileInputRef.current?.click(); }}
                      >
                        <div style={{ fontSize: '1.5rem' }}>+</div>
                        <div className="text-xs text-muted">{type}</div>
                      </div>
                    )}
                    <div className="text-xs text-muted mt-2">{type}</div>
                  </div>
                );
              })}
            </div>
          </div>

          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            style={{ display: 'none' }}
            onChange={e => {
              if (e.target.files[0]) handleUpload(e.target.files[0]);
              e.target.value = '';
            }}
          />

          {/* Audit log */}
          <button
            className="btn btn-sm btn-secondary btn-full mb-3"
            onClick={() => { setShowLogs(!showLogs); if (!showLogs) loadLogs(selectedStudent.id); }}
          >
            {showLogs ? '▲ Hide' : '▼ Show'} Audit Log
          </button>

          {showLogs && (
            <div className="card">
              {logs.length === 0 ? (
                <div className="text-sm text-muted text-center">No logs yet</div>
              ) : (
                logs.map((log, i) => (
                  <div key={i} style={{ padding: '8px 0', borderBottom: i < logs.length - 1 ? '1px solid var(--border)' : 'none' }}>
                    <div className="flex items-center justify-between">
                      <span className="text-sm" style={{ fontWeight: 600 }}>{log.action}</span>
                      <span className="text-xs text-muted">{log.performed_by}</span>
                    </div>
                    <div className="text-xs text-muted">{log.detail}</div>
                    <div className="text-xs text-muted">
                      {log.performed_at ? new Date(log.performed_at).toLocaleString() : ''}
                    </div>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
