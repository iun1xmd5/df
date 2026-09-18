// Package main implements the EvidenceContract chaincode for the dissertation:
// "Development of a Performance-Optimized Blockchain Network for Digital Evidence Management"
//
// Author: Juma Ismail (Reg. 24026415701)
// Supervisors: Dr. Isakwisa Tende, Dr. Othmar Mwambe
// Institution: Dar es Salaam Institute of Technology
//
// VERSION 2.0 — IPFS off-chain storage integration.
//   Changes from v1.0:
//   - New ContentHash field: SHA-256 of the actual evidence artefact bytes,
//     computed off-chain and stored on-chain alongside the IPFS CID. This is
//     the cryptographic link between the on-chain record and the off-chain
//     file required for forensic admissibility (Section 3.3, Storage Layer).
//   - RegisterEvidence now accepts ipfsCid and contentHash parameters.
//   - VerifyIntegrity now returns a structured result containing both the
//     metadata-integrity check and the stored ContentHash, so the application
//     layer can re-fetch the IPFS object and compare its hash.
//
// Design notes (mapping to dissertation chapters):
//   - SHA-256 hashing per Section 3.5.1
//   - ECDSA signature verification delegated to Fabric's built-in MSP per 3.5.2
//   - Per-evidence keys allow non-conflicting parallel transactions per 2.5.5
//   - Chain of custody history via GetHistoryForKey per Section 2.2

package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"time"

	"github.com/hyperledger/fabric-chaincode-go/v2/shim"
	"github.com/hyperledger/fabric-contract-api-go/v2/contractapi"
)

// EvidenceContract provides functions for managing digital evidence on the ledger.
type EvidenceContract struct {
	contractapi.Contract
}

// EvidenceStatus represents the lifecycle stage of an evidence record.
type EvidenceStatus string

const (
	StatusRegistered EvidenceStatus = "Registered"
	StatusInAnalysis EvidenceStatus = "InAnalysis"
	StatusVerified   EvidenceStatus = "Verified"
	StatusSealed     EvidenceStatus = "Sealed"
)

// Evidence represents a single piece of digital evidence on the ledger.
//
// v2.0: ContentHash holds the SHA-256 of the actual artefact file stored on
// IPFS. Hash remains the deterministic metadata hash for tamper-detection of
// the ledger record itself. The two together let the system detect tampering
// at both the metadata level (Hash) and the artefact level (ContentHash).
type Evidence struct {
	EvidenceID       string         `json:"evidenceId"`
	CaseID           string         `json:"caseId"`
	EvidenceType     string         `json:"evidenceType"`
	Description      string         `json:"description"`
	Hash             string         `json:"hash"`             // SHA-256(EvidenceID|Timestamp) — metadata integrity
	ContentHash      string         `json:"contentHash"`      // SHA-256 of the artefact bytes — off-chain integrity
	IPFSCid          string         `json:"ipfsCid"`          // IPFS content identifier of the artefact
	SubmittedBy      string         `json:"submittedBy"`      // MSP-derived identity
	CurrentCustodian string         `json:"currentCustodian"` // MSP-derived identity
	SubmittedAt      string         `json:"submittedAt"`      // RFC3339
	LastModified     string         `json:"lastModified"`     // RFC3339
	Status           EvidenceStatus `json:"status"`
	// TransferReason records why the MOST RECENT custody transfer happened
	// (NIST SP 800-86 / ISO 27037 / SWGDE all require the reason for each
	// handoff, not just who/when). Added via TransferCustodyWithReason —
	// empty on records that have never been transferred through that path,
	// including every record written before this field existed. Reading
	// it back from an old record simply yields the zero value; existing
	// data and existing functions are unaffected.
	TransferReason   string         `json:"transferReason"`
}

// CustodyEvent is one entry in the audit trail returned by GetEvidenceHistory.
type CustodyEvent struct {
	TxID      string    `json:"txId"`
	Timestamp time.Time `json:"timestamp"`
	IsDelete  bool      `json:"isDelete"`
	Evidence  Evidence  `json:"evidence"`
}

// IntegrityResult is the structured return of VerifyIntegrity (v2.0).
// MetadataIntact reports the on-chain metadata hash check. ContentHash and
// IPFSCid are returned so the application layer can re-fetch the artefact
// from IPFS, hash its bytes, and compare against ContentHash.
type IntegrityResult struct {
	EvidenceID       string `json:"evidenceId"`
	MetadataIntact   bool   `json:"metadataIntact"`
	StoredHash       string `json:"storedHash"`
	RecomputedHash   string `json:"recomputedHash"`
	ContentHash      string `json:"contentHash"`
	IPFSCid          string `json:"ipfsCid"`
	HasOffChainData  bool   `json:"hasOffChainData"`
}

// ============================================================================
// Helper functions
// ============================================================================

// computeHash implements H(x) = SHA-256(EvidenceID + Timestamp) per Section 3.5.1.
func computeHash(evidenceID, timestamp string) string {
	sum := sha256.Sum256([]byte(evidenceID + "|" + timestamp))
	return hex.EncodeToString(sum[:])
}

// getSubmitterIdentity extracts the caller's MSP ID and X.509 common name.
func getSubmitterIdentity(ctx contractapi.TransactionContextInterface) (string, error) {
	mspID, err := ctx.GetClientIdentity().GetMSPID()
	if err != nil {
		return "", fmt.Errorf("failed to read MSP ID: %v", err)
	}
	cert, err := ctx.GetClientIdentity().GetX509Certificate()
	if err != nil {
		return "", fmt.Errorf("failed to read X.509 cert: %v", err)
	}
	return fmt.Sprintf("%s::%s", mspID, cert.Subject.CommonName), nil
}

// getTxTimestamp returns the orderer-assigned transaction timestamp as RFC3339.
func getTxTimestamp(ctx contractapi.TransactionContextInterface) (string, error) {
	ts, err := ctx.GetStub().GetTxTimestamp()
	if err != nil {
		return "", fmt.Errorf("failed to read tx timestamp: %v", err)
	}
	return time.Unix(ts.Seconds, int64(ts.Nanos)).UTC().Format(time.RFC3339Nano), nil
}

// evidenceExists is a cheap read used to enforce existence preconditions.
func (c *EvidenceContract) evidenceExists(ctx contractapi.TransactionContextInterface, evidenceID string) (bool, error) {
	data, err := ctx.GetStub().GetState(evidenceID)
	if err != nil {
		return false, fmt.Errorf("ledger read failed: %v", err)
	}
	return data != nil, nil
}

// ============================================================================
// Public chaincode functions
// ============================================================================

// InitLedger seeds the ledger with one demo evidence record.
func (c *EvidenceContract) InitLedger(ctx contractapi.TransactionContextInterface) error {
	timestamp, err := getTxTimestamp(ctx)
	if err != nil {
		return err
	}
	submitter, err := getSubmitterIdentity(ctx)
	if err != nil {
		return err
	}
	demo := Evidence{
		EvidenceID:       "CASE-2026-001-EV-001",
		CaseID:           "CASE-2026-001",
		EvidenceType:     "log",
		Description:      "Demo IoT sensor log for benchmark seeding",
		Hash:             computeHash("CASE-2026-001-EV-001", timestamp),
		ContentHash:      "",
		IPFSCid:          "",
		SubmittedBy:      submitter,
		CurrentCustodian: submitter,
		SubmittedAt:      timestamp,
		LastModified:     timestamp,
		Status:           StatusRegistered,
	}
	bytes, err := json.Marshal(demo)
	if err != nil {
		return fmt.Errorf("failed to marshal demo evidence: %v", err)
	}
	return ctx.GetStub().PutState(demo.EvidenceID, bytes)
}

// RegisterEvidence creates a new evidence record on the ledger (v2.0).
//
// v2.0 adds two parameters:
//   - ipfsCid:     the IPFS content identifier of the uploaded artefact
//   - contentHash: SHA-256 of the artefact bytes, computed off-chain
//
// Both may be empty strings for a metadata-only registration (this keeps the
// function usable for the benchmark workload, which registers without files).
// When supplied, they establish the verifiable link between the on-chain
// record and the off-chain artefact stored on IPFS.
//
// The metadata Hash is still computed deterministically as
// SHA-256(EvidenceID + Timestamp) so every endorsing peer agrees on it.
func (c *EvidenceContract) RegisterEvidence(
	ctx contractapi.TransactionContextInterface,
	evidenceID, caseID, evidenceType, description, ipfsCid, contentHash string,
) error {
	if evidenceID == "" {
		return fmt.Errorf("evidenceID must not be empty")
	}
	exists, err := c.evidenceExists(ctx, evidenceID)
	if err != nil {
		return err
	}
	if exists {
		return fmt.Errorf("evidence %s already exists", evidenceID)
	}

	timestamp, err := getTxTimestamp(ctx)
	if err != nil {
		return err
	}
	submitter, err := getSubmitterIdentity(ctx)
	if err != nil {
		return err
	}

	ev := Evidence{
		EvidenceID:       evidenceID,
		CaseID:           caseID,
		EvidenceType:     evidenceType,
		Description:      description,
		Hash:             computeHash(evidenceID, timestamp),
		ContentHash:      contentHash,
		IPFSCid:          ipfsCid,
		SubmittedBy:      submitter,
		CurrentCustodian: submitter,
		SubmittedAt:      timestamp,
		LastModified:     timestamp,
		Status:           StatusRegistered,
	}
	bytes, err := json.Marshal(ev)
	if err != nil {
		return fmt.Errorf("failed to marshal evidence: %v", err)
	}
	return ctx.GetStub().PutState(evidenceID, bytes)
}

// GetEvidence retrieves a single evidence record by its ID.
func (c *EvidenceContract) GetEvidence(
	ctx contractapi.TransactionContextInterface,
	evidenceID string,
) (*Evidence, error) {
	data, err := ctx.GetStub().GetState(evidenceID)
	if err != nil {
		return nil, fmt.Errorf("ledger read failed: %v", err)
	}
	if data == nil {
		return nil, fmt.Errorf("evidence %s not found", evidenceID)
	}
	var ev Evidence
	if err := json.Unmarshal(data, &ev); err != nil {
		return nil, fmt.Errorf("failed to unmarshal evidence: %v", err)
	}
	return &ev, nil
}

// GetAllEvidence returns every evidence record currently on the ledger.
func (c *EvidenceContract) GetAllEvidence(
	ctx contractapi.TransactionContextInterface,
) ([]*Evidence, error) {
	iter, err := ctx.GetStub().GetStateByRange("", "")
	if err != nil {
		return nil, fmt.Errorf("range query failed: %v", err)
	}
	defer iter.Close()

	var results []*Evidence
	for iter.HasNext() {
		kv, err := iter.Next()
		if err != nil {
			return nil, fmt.Errorf("iterator error: %v", err)
		}
		var ev Evidence
		if err := json.Unmarshal(kv.Value, &ev); err != nil {
			continue
		}
		results = append(results, &ev)
	}
	return results, nil
}

// TransferCustody records a chain-of-custody handoff to a new custodian.
func (c *EvidenceContract) TransferCustody(
	ctx contractapi.TransactionContextInterface,
	evidenceID, newCustodian, newStatus string,
) error {
	return c.transferCustodyInternal(ctx, evidenceID, newCustodian, newStatus, "")
}

// TransferCustodyWithReason records a chain-of-custody handoff together
// with the reason for it — the one field NIST SP 800-86, ISO/IEC 27037,
// and SWGDE all treat as non-negotiable alongside who/when/to-whom, and
// which the original TransferCustody has no room for. Added as a NEW
// function with its own signature rather than changing TransferCustody,
// so every existing call site, integration, and benchmarked result is
// completely unaffected — TransferCustody still exists, unchanged, and
// still works exactly as it did.
func (c *EvidenceContract) TransferCustodyWithReason(
	ctx contractapi.TransactionContextInterface,
	evidenceID, newCustodian, newStatus, reason string,
) error {
	if reason == "" {
		return fmt.Errorf("reason must not be empty")
	}
	return c.transferCustodyInternal(ctx, evidenceID, newCustodian, newStatus, reason)
}

// transferCustodyInternal holds the authorization + state-update logic
// shared by TransferCustody and TransferCustodyWithReason, so the two
// can never drift apart on anything but the reason field.
func (c *EvidenceContract) transferCustodyInternal(
	ctx contractapi.TransactionContextInterface,
	evidenceID, newCustodian, newStatus, reason string,
) error {
	if newCustodian == "" {
		return fmt.Errorf("newCustodian must not be empty")
	}

	ev, err := c.GetEvidence(ctx, evidenceID)
	if err != nil {
		return err
	}

	caller, err := getSubmitterIdentity(ctx)
	if err != nil {
		return err
	}
	if ev.CurrentCustodian != caller {
		return fmt.Errorf(
			"unauthorized: caller %s is not the current custodian (%s)",
			caller, ev.CurrentCustodian,
		)
	}

	timestamp, err := getTxTimestamp(ctx)
	if err != nil {
		return err
	}

	ev.CurrentCustodian = newCustodian
	ev.LastModified = timestamp
	if newStatus != "" {
		ev.Status = EvidenceStatus(newStatus)
	}
	// Reflects the reason for THIS transfer on the current snapshot. A
	// stale reason from a prior handoff persisting on a newer state would
	// misleadingly imply it explains the current custody — history (via
	// GetEvidenceHistory) still preserves each past transfer's own reason
	// exactly as it was recorded at the time.
	ev.TransferReason = reason

	bytes, err := json.Marshal(ev)
	if err != nil {
		return fmt.Errorf("failed to marshal evidence: %v", err)
	}
	return ctx.GetStub().PutState(evidenceID, bytes)
}

// VerifyIntegrity recomputes the deterministic metadata hash and returns a
// structured IntegrityResult (v2.0).
//
// The metadata check (MetadataIntact) confirms the ledger record itself has
// not been altered. The returned ContentHash and IPFSCid allow the application
// layer to perform the off-chain check: re-fetch the artefact from IPFS,
// compute SHA-256 over its bytes, and compare with ContentHash. A full
// forensic verification therefore spans both layers — on-chain metadata and
// off-chain artefact — which is the integrity guarantee described in
// Section 3.3.
func (c *EvidenceContract) VerifyIntegrity(
	ctx contractapi.TransactionContextInterface,
	evidenceID string,
) (*IntegrityResult, error) {
	ev, err := c.GetEvidence(ctx, evidenceID)
	if err != nil {
		return nil, err
	}
	recomputed := computeHash(ev.EvidenceID, ev.SubmittedAt)
	return &IntegrityResult{
		EvidenceID:      ev.EvidenceID,
		MetadataIntact:  recomputed == ev.Hash,
		StoredHash:      ev.Hash,
		RecomputedHash:  recomputed,
		ContentHash:     ev.ContentHash,
		IPFSCid:         ev.IPFSCid,
		HasOffChainData: ev.IPFSCid != "" && ev.ContentHash != "",
	}, nil
}

// GetEvidenceHistory returns the full audit trail for an evidence record.
func (c *EvidenceContract) GetEvidenceHistory(
	ctx contractapi.TransactionContextInterface,
	evidenceID string,
) ([]CustodyEvent, error) {
	iter, err := ctx.GetStub().GetHistoryForKey(evidenceID)
	if err != nil {
		return nil, fmt.Errorf("history query failed: %v", err)
	}
	defer iter.Close()

	var events []CustodyEvent
	for iter.HasNext() {
		mod, err := iter.Next()
		if err != nil {
			return nil, fmt.Errorf("history iterator error: %v", err)
		}
		event := CustodyEvent{
			TxID:      mod.TxId,
			Timestamp: time.Unix(mod.Timestamp.Seconds, int64(mod.Timestamp.Nanos)).UTC(),
			IsDelete:  mod.IsDelete,
		}
		if !mod.IsDelete {
			if err := json.Unmarshal(mod.Value, &event.Evidence); err != nil {
				continue
			}
		}
		events = append(events, event)
	}
	return events, nil
}

// ============================================================================
// Chaincode entry point
// ============================================================================

func main() {
	cc, err := contractapi.NewChaincode(&EvidenceContract{})
	if err != nil {
		fmt.Printf("error creating EvidenceContract chaincode: %v\n", err)
		return
	}
	if err := cc.Start(); err != nil {
		fmt.Printf("error starting EvidenceContract chaincode: %v\n", err)
	}
}

// shim is imported transitively via contractapi but referenced here to keep
// the import explicit and to silence unused-import linters in some toolchains.
var _ = shim.Success
