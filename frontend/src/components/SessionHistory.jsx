import React, { useState, useEffect } from 'react';
import { api } from '../api';
import Icon from './Icon';

export default function SessionHistory({ onResume, sessionId, onSelectSession, onBack }) {
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [localSelected, setSelectedSession] = useState(null);
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api.getSessions().then(data => {
      setSessions(data);
      setLoading(false);
    }).catch(e => { setError(e.message); setLoading(false); });
  }, []);

  const selectedSession=sessionId || localSelected?.session_id;
  useEffect(()=>{
    if(!selectedSession)return;
    let active=true;
    api.getSession(selectedSession).then(value=>{if(active){setDetail(value);setDetailLoading(false);setError('');}}).catch(e=>{if(active){setError(e.message);setDetailLoading(false);}});
    return()=>{active=false;};
  },[selectedSession]);
  const handleSelect=session=>{if(onSelectSession)onSelectSession(session);else setSelectedSession(session);};
  const goBack=()=>{setSelectedSession(null);setDetail(null);setError('');onBack?.();};

  if (error) return <div className="notice error" role="alert">{error}</div>;
  if (loading || detailLoading || (selectedSession && detail?.session_id!==selectedSession)) {
    return <div className="loading"><div className="spinner" /></div>;
  }

  if (selectedSession && detail) {
    if (detail.status === 'active') return <div className="card"><button className="btn btn-sm btn-secondary mb-3" onClick={goBack}>← Back</button><h2>Attendance still needs review</h2><p className="form-hint mt-3">{detail.session_id} · {detail.photos.length} saved classroom photos. No attendance has been finalized.</p>{onResume && <button className="btn btn-primary" onClick={() => onResume(detail)}>Resume review</button>}</div>;
    const presentStudents = detail.students?.filter(s => s.status === 'present') || [];
    const absentStudents = detail.students?.filter(s => s.status !== 'present') || [];

    return (
      <div>
        <div className="flex items-center justify-between mb-3">
          <button className="btn btn-sm btn-secondary" onClick={goBack}>
            ← Back
          </button>
          <a
            href={api.exportSessionCsvUrl(detail.session_id)}
            download
            className="btn btn-sm btn-primary"
            style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 6 }}
          >
            <span></span> Export CSV
          </a>
        </div>

        <div className="card mb-3">
          <div className="flex items-center justify-between mb-2">
            <h2>{detail.session_id}</h2>
            <span className={`badge badge-${detail.status === 'confirmed' ? 'approved' : 'pending'}`}>
              {detail.status}
            </span>
          </div>
          <div className="text-sm text-muted">
            {new Date(detail.date).toLocaleString()} · {detail.periods} period{detail.periods > 1 ? 's' : ''}
          </div>
        </div>

        {/* Class photos */}
        {detail.photos?.map((p, i) => (
          <div key={i} className="card mb-3">
            <div className="card-title mb-2">Class Photo {i + 1}</div>
            <div className="class-photo-wrapper">
              <img src={p.annotated_url || p.url} alt="Class" />
            </div>
          </div>
        ))}

        {/* Summary */}
        <div className="summary-bar mb-3">
          <div className="summary-item">
            <div className="summary-value" style={{ color: 'var(--success)' }}>{presentStudents.length}</div>
            <div className="summary-label">Present</div>
          </div>
          <div className="summary-item">
            <div className="summary-value" style={{ color: 'var(--danger)' }}>{absentStudents.length}</div>
            <div className="summary-label">Absent</div>
          </div>
        </div>

        {/* Present students */}
        {presentStudents.length > 0 && (
          <div className="card mb-3">
            <div className="card-title mb-2" style={{ color: 'var(--success)' }}> Present</div>
            {presentStudents.map((s, i) => (
              <div key={i} className="result-row">
                <div className="result-row-header">
                  <div>
                    <div className="student-name">{s.name}</div>
                    <div className="student-roll">{s.roll_no}</div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="badge badge-present">
                      {s.method === 'manual' ? ' Manual' : 'Auto'}
                    </span>
                    {s.confidence > 0 && (
                      <span className="text-xs text-muted">Score {s.confidence.toFixed(3)}</span>
                    )}
                  </div>
                </div>
                {s.method === 'manual' && s.manual_reason && (
                  <div className="text-xs text-muted mt-2">Reason: {s.manual_reason}</div>
                )}
                {(s.crop_url || (s.method !== 'manual' && s.enrolled_photo_url)) && (
                  <div className="result-photos">
                    {s.enrolled_photo_url && (
                      <div style={{ textAlign: 'center' }}>
                        <img src={s.enrolled_photo_url} alt="Enrolled" />
                        <div className="text-xs text-muted">Enrolled</div>
                      </div>
                    )}
                    {s.crop_url && (
                      <>
                        <span className="arrow" style={{ color: 'var(--text-muted)' }}>↔</span>
                        <div style={{ textAlign: 'center' }}>
                          <img src={s.crop_url} alt="Detected" />
                          <div className="text-xs text-muted">Detected</div>
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Absent students */}
        {absentStudents.length > 0 && (
          <div className="card">
            <div className="card-title mb-2" style={{ color: 'var(--danger)' }}> Absent</div>
            {absentStudents.map((s, i) => (
              <div key={i} className="student-row" style={{ cursor: 'default' }}>
                {s.enrolled_photo_url && (
                  <img src={s.enrolled_photo_url} alt={s.name} className="student-avatar" />
                )}
                <div className="student-info">
                  <div className="student-name">{s.name}</div>
                  <div className="student-roll">{s.roll_no}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div>


      {sessions.length === 0 ? (
        <div className="card text-center" style={{ padding: 32 }}>
          <div className="mb-3"><Icon name="clock" size={28}/></div>
          <p className="text-muted">No sessions yet. Take attendance to create one.</p>
        </div>
      ) : (
        sessions.map((s, i) => (
          <div key={i} className="session-card" onClick={() => handleSelect(s)}>
            <div className="session-icon">
              <Icon name={s.status === 'confirmed' ? 'check' : 'clock'} size={20}/>
            </div>
            <div className="session-info">
              <div className="session-id">{s.subject_name} · {s.class_name}</div><div className="text-xs text-muted">{s.session_id}</div>
              <div className="session-meta">
                {new Date(s.date).toLocaleDateString()} · {s.periods} period{s.periods > 1 ? 's' : ''}
              </div>
            </div>
            <div className="session-stat">
              <div className="session-stat-value">{s.status === 'active' ? 'In review' : `${s.present_count}/${s.total_students}`}</div>
              <div className="session-stat-label">{s.status === 'active' ? 'Not finalized' : 'present'}</div>
            </div>
          </div>
        ))
      )}
    </div>
  );
}
