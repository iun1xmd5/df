# DEMS — live application layer

This folder holds the **running Digital Evidence Management System
application** — frontend, backend, and the current chaincode it talks to.
It is a separate artifact from the rest of this repository, which
contains the reproducibility materials (chaincode snapshot, network
configs, Caliper benchmarks, analysis pipeline) for the paper *Scaling
Hyperledger Fabric for Forensic Evidence Registration*.

**Important distinction:** `evidence-chaincode/` here is the **live,
evolving** application chaincode (adds officer-signed custody transfers
with a recorded reason, per NIST SP 800-86 / ISO 27037 / SWGDE chain-of-
custody requirements, on top of the same six core operations). It is a
different artifact from `../chaincode/evidence-contract/` at the repo
root, which is the **frozen snapshot** that produced this paper's actual
benchmark numbers and must not be confused with or substituted for it.

## Contents

- `DEMS_Application_Layer/` — Node.js/Express backend (Fabric Gateway
  client + REST API) and a single-file vanilla-JS frontend (no build
  step).
- `evidence-chaincode/` — the live `EvidenceContract` chaincode, Go.
- `scripts/` — officer enrollment, credential generation, a status-check
  script, and the systemd unit files used to run the stack as
  auto-restarting services.

## Setup

See the header comments in `scripts/enroll-officers.sh` and
`scripts/make-credentials.js` for the environment-variable pattern used
to configure officer identities and credentials — no real credentials
are hardcoded in this repository. Broadly:

```bash
# 1. Deploy evidence-chaincode/ to your running Fabric channel
# 2. Enroll named officer identities (Fabric CA) — see enroll-officers.sh
# 3. Generate officers.auth.json — see make-credentials.js (gitignored,
#    generated locally, never committed)
# 4. cd DEMS_Application_Layer/backend && npm install && node server.js
```

Backend configuration is environment-variable driven — see the `CFG`
object at the top of `DEMS_Application_Layer/backend/server.js`.
