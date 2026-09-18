#!/usr/bin/env bash
# Deploys EvidenceContract and smoke-tests all 6 operations.
# Run from: ~/dissertation/fabric-samples/test-network

set -euo pipefail

CC_NAME="evidence"
CC_VERSION="1.0"
CHANNEL="evidencechannel"
CC_PATH="../evidence-chaincode"

if [[ ! -f network.sh ]]; then
    echo "ERROR: run this script from inside fabric-samples/test-network"
    exit 1
fi

echo "=========================================="
echo " Deploying EvidenceContract chaincode"
echo "=========================================="

./network.sh deployCC \
    -c "$CHANNEL" \
    -ccn "$CC_NAME" \
    -ccp "$CC_PATH" \
    -ccl go \
    -ccv "$CC_VERSION"

export PATH="${PWD}/../bin:$PATH"
export FABRIC_CFG_PATH="${PWD}/../config/"
export CORE_PEER_TLS_ENABLED=true
export CORE_PEER_LOCALMSPID="Org1MSP"
export CORE_PEER_TLS_ROOTCERT_FILE="${PWD}/organizations/peerOrganizations/org1.example.com/peers/peer0.org1.example.com/tls/ca.crt"
export CORE_PEER_MSPCONFIGPATH="${PWD}/organizations/peerOrganizations/org1.example.com/users/Admin@org1.example.com/msp"
export CORE_PEER_ADDRESS=localhost:7051

ORDERER_CA="${PWD}/organizations/ordererOrganizations/example.com/orderers/orderer.example.com/msp/tlscacerts/tlsca.example.com-cert.pem"
ORG1_TLS="${PWD}/organizations/peerOrganizations/org1.example.com/peers/peer0.org1.example.com/tls/ca.crt"
ORG2_TLS="${PWD}/organizations/peerOrganizations/org2.example.com/peers/peer0.org2.example.com/tls/ca.crt"

invoke() {
    local fn="$1"; shift
    local args_json
    args_json=$(printf '"%s",' "$@")
    args_json="[${args_json%,}]"
    peer chaincode invoke \
        -o localhost:7050 \
        --ordererTLSHostnameOverride orderer.example.com \
        --tls --cafile "$ORDERER_CA" \
        -C "$CHANNEL" -n "$CC_NAME" \
        --peerAddresses localhost:7051 --tlsRootCertFiles "$ORG1_TLS" \
        --peerAddresses localhost:9051 --tlsRootCertFiles "$ORG2_TLS" \
        -c "{\"function\":\"$fn\",\"Args\":${args_json}}"
}

query() {
    local fn="$1"; shift
    local args_json
    args_json=$(printf '"%s",' "$@")
    args_json="[${args_json%,}]"
    peer chaincode query \
        -C "$CHANNEL" -n "$CC_NAME" \
        -c "{\"function\":\"$fn\",\"Args\":${args_json}}"
}

sleep 3

echo ""
echo "=========================================="
echo " Smoke test: 6 EvidenceContract operations"
echo "=========================================="

echo ""
echo "[1/6] InitLedger"
invoke InitLedger
sleep 2

echo ""
echo "[2/6] RegisterEvidence CASE-2026-001-EV-002"
invoke RegisterEvidence \
    "CASE-2026-001-EV-002" \
    "CASE-2026-001" \
    "image" \
    "Photograph of seized hard drive at scene"
sleep 2

echo ""
echo "[3/6] GetEvidence CASE-2026-001-EV-002"
query GetEvidence "CASE-2026-001-EV-002"

echo ""
echo "[4/6] VerifyIntegrity CASE-2026-001-EV-002 (expect true)"
query VerifyIntegrity "CASE-2026-001-EV-002"

echo ""
echo "[5/6] GetAllEvidence"
query GetAllEvidence

echo ""
echo "[6/6] GetEvidenceHistory CASE-2026-001-EV-002"
query GetEvidenceHistory "CASE-2026-001-EV-002"

echo ""
echo "=========================================="
echo " Smoke test complete"
echo "=========================================="
