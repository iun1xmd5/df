# Saturation-Sweep Protocol

Reproduces Appendix A.1 of the paper. The sweep locates each
configuration's saturation ceiling by varying the offered write load.

## Design

| Factor | Levels |
|---|---|
| Peer count | 5, 10, 15 |
| Offered load (TPS) | 100, 200, 300, 400, 500, 750, 1000 |
| Replicates per cell | 5 |

Total: 3 × 7 × 5 = 105 runs, each 1000 transactions (105,000 total).

## Procedure

For each (peer count, offered load) cell:

1. Tear down and rebuild the network.
2. Deploy the EvidenceContract chaincode and initialize the ledger.
3. Configure Caliper with the target offered load.
4. Execute 1000 `RegisterEvidence` transactions.
5. Record sustained throughput, mean latency with 95% CI, failure rate
   by type, and orderer/peer CPU/memory utilization.
6. Repeat five times.

## Analysis

Fit a throughput-versus-offered-load curve per configuration and identify
the saturation point as the offered load at which sustained throughput
departs from the y = x line by more than 5%. See the paper for the three
possible outcomes (invariant, peer-dependent, orderer-limited).
