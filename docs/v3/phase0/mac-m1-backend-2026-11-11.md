# desolate v3 Phase 0, round 3: the Lima/vz backend (macOS 14.5, limactl version 2.1.2)

| part | measure | value |
|---|---|---|
| A | template VM: create + boot | as expected (ok) |
| A | template VM: create + boot took | 14.8 s |
| A | template: dockerd, devcontainer CLI, one devcontainer built (image + node feature) | as expected (ok) |
| A | template: provisioning + first devcontainer build took | 136.2 s |
| A | template: docker disk | 1076 MB |
| A | template VM directory on disk (du -sh) | 5.3G |
| A | clone with --set '.mounts = [...]' (12 shares) | ok, 0.1 s |
| A | clone: boot with 12 shares | as expected (ok) |
| A | clone: boot to SSH ready | 9.7 s |
| A | clone: dockerd answers | as expected (ok) |
| A | clone: wait for dockerd | 0.3 s |
| A | clone: the template's image is in the clone's docker (images) | 2 |
| A | clone: devcontainer up (nothing to build) | as expected (ok) |
| A | clone: devcontainer up took | 0.7 s |
| A | **clone -> devcontainer ready, total** (the 15 s target, without the editor) | 11.0 s |
| A | clone: a command inside its devcontainer | as expected (ok) |
| B | virtiofs mounts in the clone (want 12) | 12 |
| B | the template's share is gone from the clone | as expected (refused) |
| B | all ten nested read-only shares readable, each its own content | as expected (ok) |
| B | control: root writes the writable share | as expected (ok) |
| B | root writes a nested read-only share | as expected (refused) |
| B | root creates a file in the PARENT of the nested shares (the VM's own disk; exit code) | 0 |
| B | what the Mac sees in that parent (want only repo7.git) | repo7.git  |
| C | ssh -W into the guest's 127.0.0.1:8000 returns the page | **UNEXPECTED: refused, wanted ok** |
| C | 20 sequential streams over ssh -W | 0.1 s total |
| C | 20 concurrent streams over ssh -W | 0.0 s total, 0 of 20 answered |
| C | ssh -W to a guest port nobody listens on | as expected (refused) |
| C | for comparison: one 'limactl shell' round trip | 0.1 s |
| D | guest downloads 300 MB from the Mac's loopback via host.lima.internal (bytes/s) | 366379182 |
| D | same, 8 downloads at once (bytes/s each) | 0 0 72299929 71922048 71596673 63351520 49386547 48043824  |
