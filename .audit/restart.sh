powershell -NoProfile -File kill.ps1; sleep 8; curl -s -m 3 localhost:4000/api/health | head -c 30; echo
