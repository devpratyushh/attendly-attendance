# Attendly frontend

React 19 / Vite 8 frontend with React Router, role-specific workspaces, camera capture, and an encrypted persistent offline queue.

See the [project README](../README.md) for setup, account provisioning, data storage, and deployment status, and the [architecture guide](../docs/architecture-and-offline.md) for synchronization and privacy details.

```bash
npm ci
npm run dev
```

The development server uses port 3000 and proxies `/api` and `/static` to the FastAPI service on port 8000. Run the backend separately or use `./run.sh` from the project root.

```bash
npm run build
npm run lint
node --test tests/*.test.js
```

Browser fixtures under `tests/` are development-only and use synthetic data. `/tests/offline.html` runs isolated browser-storage checks with a simulated server.
