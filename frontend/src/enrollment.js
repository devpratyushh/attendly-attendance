export const ENROLLMENT_STATUSES = {
  ready: { label: 'Ready for recognition', badge: 'badge-approved' },
  consent: { label: 'Consent required', badge: 'badge-awaiting-consent' },
  enrollment: { label: 'Needs enrollment', badge: 'badge-needs-enrollment' },
};

export function enrollmentStatus(student) {
  // Missing biometrics is an enrollment issue, regardless of consent state.
  if (!student.has_embeddings) return 'enrollment';
  if (!student.consent_given) return 'consent';
  return 'ready';
}
