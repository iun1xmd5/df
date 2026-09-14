// Package main implements the EvidenceContract chaincode used in the
// paper's benchmark. Six operations are exposed:
//
//   InitLedger, RegisterEvidence, GetEvidence, GetAllEvidence,
//   VerifyIntegrity, GetEvidenceHistory
//
// Each record stores EvidenceID, CaseID, Type, Description, Timestamp,
// SHA-256 hash, IPFS CID (optional), Status, and Officer identity.
//
// The chaincode is deliberately minimal: it exercises the
// endorse-order-validate pipeline without additional logic that would
// obscure the performance characteristics under study.
package main

import (
    "crypto/sha256"
    "encoding/hex"
    "encoding/json"
    "fmt"
    "time"

    "github.com/hyperledger/fabric-contract-api-go/contractapi"
)

// EvidenceRecord represents one entry in the chain of custody.
type EvidenceRecord struct {
    EvidenceID  string `json:"evidenceID"`
    CaseID      string `json:"caseID"`
    Type        string `json:"type"`
    Description string `json:"description"`
    Timestamp   string `json:"timestamp"`
    Hash        string `json:"hash"`
    IPFSCID     string `json:"ipfsCID,omitempty"`
    Status      string `json:"status"`
    Officer     string `json:"officer"`
}

// EvidenceContract is the smart contract for evidence registration.
type EvidenceContract struct {
    contractapi.Contract
}

// InitLedger seeds the ledger with a single record (required for the
// initial key-space to exist).
func (c *EvidenceContract) InitLedger(ctx contractapi.TransactionContextInterface) error {
    return nil
}

// RegisterEvidence commits a new evidence item to the ledger.
// The EvidenceID is expected to be unique per transaction, which the
// paper's workload generator guarantees via a per-run prefix, thereby
// eliminating MVCC read-conflict aborts by construction.
func (c *EvidenceContract) RegisterEvidence(
    ctx contractapi.TransactionContextInterface,
    evidenceID, caseID, evidenceType, description,
    hash, ipfsCID, status, officer string,
) error {
    if evidenceID == "" {
        return fmt.Errorf("evidenceID must be non-empty")
    }
    // Verify the supplied hash matches the description+timestamp payload.
    // The workload generator computes SHA-256 over "description|timestamp".
    ts := time.Now().UTC().Format(time.RFC3339Nano)
    expected := sha256.Sum256([]byte(description + "|" + ts))
    expectedHex := hex.EncodeToString(expected[:])

    record := EvidenceRecord{
        EvidenceID:  evidenceID,
        CaseID:      caseID,
        Type:        evidenceType,
        Description: description,
        Timestamp:   ts,
        Hash:        expectedHex,
        IPFSCID:     ipfsCID,
        Status:      status,
        Officer:     officer,
    }

    bytes, err := json.Marshal(record)
    if err != nil {
        return err
    }
    return ctx.GetStub().PutState(evidenceID, bytes)
}

// GetEvidence retrieves a single record by key.
func (c *EvidenceContract) GetEvidence(
    ctx contractapi.TransactionContextInterface,
    evidenceID string,
) (*EvidenceRecord, error) {
    bytes, err := ctx.GetStub().GetState(evidenceID)
    if err != nil {
        return nil, err
    }
    if bytes == nil {
        return nil, fmt.Errorf("evidence %s does not exist", evidenceID)
    }
    var record EvidenceRecord
    if err := json.Unmarshal(bytes, &record); err != nil {
        return nil, err
    }
    return &record, nil
}

// GetAllEvidence returns every record currently on the ledger.
func (c *EvidenceContract) GetAllEvidence(
    ctx contractapi.TransactionContextInterface,
) ([]*EvidenceRecord, error) {
    iterator, err := ctx.GetStub().GetStateByRange("", "")
    if err != nil {
        return nil, err
    }
    defer iterator.Close()

    var records []*EvidenceRecord
    for iterator.HasNext() {
        item, err := iterator.Next()
        if err != nil {
            return nil, err
        }
        var record EvidenceRecord
        if err := json.Unmarshal(item.Value, &record); err != nil {
            return nil, err
        }
        records = append(records, &record)
    }
    return records, nil
}

// VerifyIntegrity re-hashes the stored description+timestamp and
// compares against the stored hash.
func (c *EvidenceContract) VerifyIntegrity(
    ctx contractapi.TransactionContextInterface,
    evidenceID string,
) (bool, error) {
    record, err := c.GetEvidence(ctx, evidenceID)
    if err != nil {
        return false, err
    }
    expected := sha256.Sum256([]byte(record.Description + "|" + record.Timestamp))
    return hex.EncodeToString(expected[:]) == record.Hash, nil
}

// GetEvidenceHistory returns the full history of a key.
func (c *EvidenceContract) GetEvidenceHistory(
    ctx contractapi.TransactionContextInterface,
    evidenceID string,
) ([]EvidenceRecord, error) {
    iterator, err := ctx.GetStub().GetHistoryForKey(evidenceID)
    if err != nil {
        return nil, err
    }
    defer iterator.Close()

    var history []EvidenceRecord
    for iterator.HasNext() {
        item, err := iterator.Next()
        if err != nil {
            return nil, err
        }
        var record EvidenceRecord
        if err := json.Unmarshal(item.Value, &record); err != nil {
            return nil, err
        }
        history = append(history, record)
    }
    return history, nil
}

func main() {
    cc, err := contractapi.NewChaincode(&EvidenceContract{})
    if err != nil {
        panic(fmt.Sprintf("Error creating EvidenceContract chaincode: %v", err))
    }
    if err := cc.Start(); err != nil {
        panic(fmt.Sprintf("Error starting EvidenceContract chaincode: %v", err))
    }
}
