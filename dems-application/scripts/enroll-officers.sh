#!/usr/bin/env bash
# ============================================================
# enroll-officers.sh
# Enrols named investigating-officer identities in Org1 and Org2
# through the Fabric CA, so the EvidenceContract chaincode records
# real officer names (e.g. Org1MSP::juma.ismail) instead of the
# generic test-network user1.
#
# Run from the test-network directory:
#   cd fabric-samples/test-network
#
# Configure the officer roster via environment variables before running
# (no real names/CA secrets are hardcoded in this script). Each officer
# needs a username, an org ("org1" or "org2"), and a CA enrollment secret
# — this is the Fabric CA registration secret, NOT the officer's DEMS web
# login password (that's configured separately, in make-credentials.js):
#
#   OFFICER_1_USERNAME=juma.ismail OFFICER_1_ORG=org1 OFFICER_1_CA_SECRET=... \
#   OFFICER_2_USERNAME=asha.mwakea OFFICER_2_ORG=org1 OFFICER_2_CA_SECRET=... \
#   OFFICER_3_USERNAME=peter.kessy OFFICER_3_ORG=org2 OFFICER_3_CA_SECRET=... \
#   bash scripts/enroll-officers.sh
#
# Add more officers by continuing the OFFICER_<n>_* numbering.
#
# Safe to re-run: identities that already exist are skipped.
# Resilient: one officer failing does not abort the others.
# ============================================================

NETWORK_HOME="$(pwd)"
if [ ! -d "${NETWORK_HOME}/organizations/fabric-ca" ]; then
  echo "ERROR: run this from the test-network directory:"
  echo "  cd fabric-samples/test-network"
  exit 1
fi

export PATH="${NETWORK_HOME}/../bin:$PATH"

CA_ORG1_TLS="${NETWORK_HOME}/organizations/fabric-ca/org1/tls-cert.pem"
CA_ORG2_TLS="${NETWORK_HOME}/organizations/fabric-ca/org2/tls-cert.pem"

# ------------------------------------------------------------
# Officer roster, loaded from OFFICER_<n>_USERNAME / _ORG / _CA_SECRET.
# ------------------------------------------------------------
OFFICERS=()
i=1
while true; do
  uname_var="OFFICER_${i}_USERNAME"
  org_var="OFFICER_${i}_ORG"
  secret_var="OFFICER_${i}_CA_SECRET"
  uname="${!uname_var:-}"
  [ -z "$uname" ] && break
  org="${!org_var:-}"
  secret="${!secret_var:-}"
  if [ -z "$org" ] || [ -z "$secret" ]; then
    echo "[skip] OFFICER_${i}_USERNAME=${uname} set but OFFICER_${i}_ORG or " \
         "OFFICER_${i}_CA_SECRET is missing — skipped."
  else
    OFFICERS+=("${org}|${uname}|${secret}")
  fi
  i=$((i+1))
done

if [ "${#OFFICERS[@]}" -eq 0 ]; then
  echo "No officers configured. Set OFFICER_1_USERNAME / _ORG / _CA_SECRET" \
       "(see the header comment in this file for the full pattern), then re-run."
  exit 1
fi

OK_COUNT=0
FAIL_COUNT=0
FAILED=""

enroll_officer() {
  local org="$1" user="$2" pass="$3"
  local caname caport catls peerdomain
  if [ "$org" = "org1" ]; then
    caname="ca-org1"; caport=7054; catls="$CA_ORG1_TLS"
    peerdomain="org1.example.com"
  else
    caname="ca-org2"; caport=8054; catls="$CA_ORG2_TLS"
    peerdomain="org2.example.com"
  fi

  local mspdir="${NETWORK_HOME}/organizations/peerOrganizations/${peerdomain}/users/${user}@${peerdomain}/msp"
  export FABRIC_CA_CLIENT_HOME="${NETWORK_HOME}/organizations/peerOrganizations/${peerdomain}/"

  if compgen -G "${mspdir}/signcerts/*.pem" > /dev/null 2>&1; then
    echo "  - ${org}/${user}: already enrolled, skipping"
    OK_COUNT=$((OK_COUNT+1))
    return 0
  fi
  rm -rf "${mspdir}"

  echo "  - ${org}/${user}: registering..."
  # register may fail harmlessly if the identity already exists in the CA
  fabric-ca-client register \
    --caname "${caname}" \
    --id.name "${user}" --id.secret "${pass}" --id.type client \
    --tls.certfiles "${catls}"

  echo "  - ${org}/${user}: enrolling..."
  if fabric-ca-client enroll \
       -u "https://${user}:${pass}@localhost:${caport}" \
       --caname "${caname}" \
       -M "${mspdir}" \
       --tls.certfiles "${catls}"; then
    cp "${NETWORK_HOME}/organizations/peerOrganizations/${peerdomain}/msp/config.yaml" \
       "${mspdir}/config.yaml" 2>/dev/null || true
    echo "    OK -> ${mspdir}"
    OK_COUNT=$((OK_COUNT+1))
  else
    echo "    FAILED to enroll ${org}/${user}"
    FAIL_COUNT=$((FAIL_COUNT+1))
    FAILED="${FAILED} ${org}/${user}"
  fi
}

echo "Enrolling named officer identities..."
echo ""
for entry in "${OFFICERS[@]}"; do
  IFS='|' read -r org user pass <<< "$entry"
  enroll_officer "$org" "$user" "$pass"
done

echo ""
echo "============================================================"
echo "Enrolled OK: ${OK_COUNT} / ${#OFFICERS[@]}"
if [ "$FAIL_COUNT" -gt 0 ]; then
  echo "FAILED:     ${FAILED}"
  echo ""
  echo "To see WHY one failed, run its enroll command directly, e.g.:"
  echo "  export PATH=\"${NETWORK_HOME}/../bin:\$PATH\""
  echo "  export FABRIC_CA_CLIENT_HOME=\"${NETWORK_HOME}/organizations/peerOrganizations/<org-domain>/\""
  echo "  fabric-ca-client enroll -u https://<username>:<ca-secret>@localhost:<7054|8054> \\"
  echo "    --caname <ca-org1|ca-org2> -M /tmp/test-msp \\"
  echo "    --tls.certfiles <path-to-ca-tls-cert>"
fi
echo "============================================================"
echo ""
echo "Enrolled officers now available:"
for entry in "${OFFICERS[@]}"; do
  IFS='|' read -r org user pass <<< "$entry"
  peerdomain="${org}.example.com"
  mspdir="${NETWORK_HOME}/organizations/peerOrganizations/${peerdomain}/users/${user}@${peerdomain}/msp"
  if [ -d "${mspdir}/signcerts" ]; then
    echo "  ${org}MSP :: ${user}"
  fi
done
