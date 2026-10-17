# Walkthrough screenshots

These JPEG screenshots were captured from the local application for the root README. Portal and review screens use isolated synthetic fixtures; sign-in contains no credentials. No real student photographs, biometric submissions, school records, or authentication secrets are included.

## Reproduce

Start the local frontend/backend as described in the root README. Capture the rendered screens at a desktop viewport (approximately 1280 × 720):

| Image | Development page | State |
| --- | --- | --- |
| `01-sign-in.jpg` | `/login/teacher` | Signed out; leave fields empty |
| `02-teacher-dashboard.jpg` | `/tests/portal.html?role=teacher` | Class teacher overview |
| `03-capture-options.jpg` | `/tests/review.html?capture` | Open the capture-mode dropdown; do not start capture |
| `04-attendance-review.jpg` | `/tests/review.html` | Collapse classroom photos and scroll to the review controls |
| `05-student-portal.jpg` | `/tests/portal.html?role=student` | Student overview |

The review fixture disables real confirmation. It supports `?capture` to show the initial capture controls without creating attendance. Fixture pages are development-only, are excluded from production builds, and do not represent recognition benchmarks.
