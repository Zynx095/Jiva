/** Reset the running local demo to its seeded state (DEMO ADMIN persona). */
const API = process.env.API_URL || 'http://localhost:4000';

fetch(`${API}/api/demo/reset`, { method: 'POST', headers: { 'x-jiva-demo-user': 'demo-admin' } })
  .then(async res => {
    console.log(res.ok ? `✓ Demo reset (${await res.text()})` : `✗ Reset failed: ${res.status}`);
    if (!res.ok) process.exit(1);
  })
  .catch(() => {
    console.error(`✗ API not reachable at ${API}`);
    process.exit(1);
  });
