import StudentAvatar from './StudentAvatar';

export default function ProfileCard({ person, roleLabel }) {
  const hasPhoto = Boolean(person.profile_photo_url || person.photos?.length) && person.consent_given !== false;
  return <section className="profile-card">
    <div className="profile-card-heading"><StudentAvatar student={person} size={76}/><div><h3>{person.name}</h3><span className="badge neutral">{roleLabel || person.role}</span></div></div>
    <dl className="profile-facts">{[['Username',person.username],['Roll number',person.roll_no],['Class',person.class_name],['Email',person.email]].filter(([,value])=>value).map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
    <p className="profile-photo-note">{person.role==='student' ? hasPhoto ? 'Profile photo from approved biometric enrollment.' : 'Your approved enrollment photo will appear here.' : 'Initials avatar'}</p>
  </section>;
}
