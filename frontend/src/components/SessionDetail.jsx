import React from 'react';
import EvidencePhoto from './EvidencePhoto';
import Icon from './Icon';

export default function SessionDetail({ session, onBack }) {
  const isManual = session.method === 'manual';
  const photos = session.class_photos?.length ? session.class_photos : session.class_photo_url ? [{ url: session.class_photo_url }] : [];

  return (
    <div>
      <button className="btn btn-sm btn-secondary mb-3" onClick={onBack}>
        ← Back
      </button>

      <div className="card">
        <div className="card-title mb-2">Session Details</div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 16 }}>
          <div>
            <div className="text-xs text-muted">Session ID</div>
            <div className="text-sm" style={{ fontWeight: 600 }}>{session.session_id}</div>
          </div>
          <div>
            <div className="text-xs text-muted">Status</div>
            <span className={`badge badge-${session.status}`}>{session.status}</span>
          </div>
          <div>
            <div className="text-xs text-muted">Date & Time</div>
            <div className="text-sm">{new Date(session.date).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}</div>
          </div>
          <div>
            <div className="text-xs text-muted">Periods</div>
            <div className="text-sm" style={{ fontWeight: 600 }}>{session.periods}</div>
          </div>
        </div>

        {isManual ? (
          <div className="card" style={{ background: 'var(--bg-glass)', marginTop: 12 }}>
            <div className="flex items-center gap-2 mb-2">
              <span style={{ fontSize: '1.2rem' }}></span>
              <span style={{ fontWeight: 600 }}>Marked by Faculty</span>
            </div>
            <div className="text-sm text-muted">
              Reason: {session.manual_reason || 'Not specified'}
            </div>
          </div>
        ) : null}
        {(session.matched_crop_url || (!isManual && session.status === 'present' && session.enrolled_photo_url)) && (
          <div style={{ marginTop: 12 }}>
            <div className="text-xs text-muted mb-2">Class detection</div>
            <div className="photo-compare">
              {session.enrolled_photo_url && (
                <div style={{ textAlign: 'center' }}>
                  <img src={session.enrolled_photo_url} alt="Enrolled" />
                  <div className="text-xs text-muted mt-2">Enrolled</div>
                </div>
              )}
              <span className="arrow">↔</span>
              {session.matched_crop_url && (
                <div style={{ textAlign: 'center' }}>
                  <img src={session.matched_crop_url} alt="Your face detected in class" />
                  <div className="text-xs text-muted mt-2">Detected in class</div>
                </div>
              )}
            </div>
            {session.confidence != null && (
              <div className="text-xs text-muted mt-2">
                Match score: {session.confidence.toFixed(3)}
              </div>
            )}

          </div>
        )}
        {photos.length > 0 && (
          <details className="session-photo-section">
            <summary className="text-button">View class photos ({photos.length})</summary>
            {photos.map((photo, index) => (
              <div key={photo.id || photo.url} className="session-class-photo">
                <EvidencePhoto photo={photo} evidence={photo} index={index} showBoxes caption={<>
                  <span className="session-photo-caption"><strong>Class view {index + 1}</strong><span><Icon name={photo.detections?.length ? 'face' : 'camera'} size={15}/>{photo.detections?.length ? 'Your face highlighted' : 'No saved face detection in this view'}</span></span>
                  <a className="btn btn-secondary btn-sm session-photo-original" href={photo.url} target="_blank" rel="noreferrer" aria-label={`Open original full-size photo for class view ${index + 1} (opens in a new tab)`}>View full size<Icon name="arrow" size={16}/></a>
                </>}/>
              </div>
            ))}
          </details>
        )}
      </div>
    </div>
  );
}
