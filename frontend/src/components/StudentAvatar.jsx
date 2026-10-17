import { useState } from 'react';

export default function StudentAvatar({ student, size }) {
  const [failedSource, setFailedSource] = useState(null);
  const source = student.consent_given === false ? null : student.profile_photo_url || student.photos?.find(photo => photo.type === 'front')?.url || student.photos?.[0]?.url;
  const name = student.name?.trim() || 'Student';
  const initials = name.split(/\s+/).slice(0, 2).map(part => Array.from(part)[0]).join('').toUpperCase();
  const style = size ? { width: size, height: size } : undefined;
  return source && source !== failedSource
    ? <img className="student-avatar" src={source} alt={name} loading="lazy" style={style} onError={() => setFailedSource(source)} />
    : <span className="student-avatar student-avatar-placeholder" role="img" aria-label={`${name} — initials avatar`} style={style}>{initials}</span>;
}
