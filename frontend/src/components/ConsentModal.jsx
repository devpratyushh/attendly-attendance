import React from 'react';

export default function ConsentModal({ student, onAccept, onDecline }) {
  return (
    <div className="modal-overlay" onClick={onDecline}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">🔒 Biometric Consent</div>
        <div className="modal-body">
          <p style={{ marginBottom: 12 }}>
            <strong>{student?.name}</strong>, this app uses facial recognition for
            attendance marking. Your biometric data (facial embeddings) will be:
          </p>
          <ul style={{ paddingLeft: 20, marginBottom: 12, lineHeight: 1.8 }}>
            <li>Stored <strong>locally</strong> on this device only</li>
            <li>Used <strong>solely</strong> for attendance verification</li>
            <li>Never shared with third parties</li>
            <li>Deletable at your request</li>
          </ul>
          <p>
            By continuing, you consent to the collection and use of your facial
            biometric data for class attendance purposes.
          </p>
        </div>
        <div className="modal-actions">
          <button className="btn btn-secondary" style={{ flex: 1 }} onClick={onDecline}>
            Decline
          </button>
          <button className="btn btn-primary" style={{ flex: 1 }} onClick={onAccept}>
            I Consent
          </button>
        </div>
      </div>
    </div>
  );
}
