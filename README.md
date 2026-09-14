# Scaling Hyperledger Fabric for Forensic Evidence Registration

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Hyperledger Fabric](https://img.shields.io/badge/Fabric-v2.5.9-blue)](https://hyperledger-fabric.readthedocs.io/)
[![Python](https://img.shields.io/badge/Python-3.11+-blue)](https://www.python.org/)

Reproducibility artifacts for the paper:

> **Scaling Hyperledger Fabric for Forensic Evidence Registration: A Replicated Study of Latency--Throughput Trade-offs**  
> Stephen Wambura and Juma Ismail  
> *Forensic Science International: Digital Investigation* (under review)

## Overview

This repository contains the chaincode, network configuration, benchmarking workloads, and Python analysis pipeline used to produce the empirical results reported in the paper. The study examines how peer count (5, 10, 15) affects write latency and sustained throughput in a permissioned Hyperledger Fabric network running a forensic evidence-registration workload.

### Key results

| Metric | 5 peers | 10 peers | 15 peers |
|---|---|---|---|
| Write latency (reg-1000) | 0.396 s | 0.428 s | 0.524 s |
| Sustained throughput (100 TPS offered) | 96.64 TPS | 95.54 TPS | 96.42 TPS |
| Read latency (query-1000) | 0.010 s | 0.010 s | 0.010 s |

**Finding:** Write latency rises monotonically with peer count (32% over the 5--15 range; Holm–Bonferroni-adjusted p < 0.006), while sustained throughput remains within 1.1% of the 100-TPS offered load across all configurations. The paper calls this the *latency-dominant regime*: at the tested load, the network is latency-limited, not capacity-limited.

## Repository Contents

| Directory | Purpose |
|---|---|
| `chaincode/` | The `EvidenceContract` chaincode in Go, exposing six operations (InitLedger, RegisterEvidence, GetEvidence, GetAllEvidence, VerifyIntegrity, GetEvidenceHistory). |
| `network/` | Fabric network configuration for the 5-, 10-, and 15-peer topologies, including `configtx.yaml`, `crypto-config.yaml`, and Docker Compose overrides. |
| `caliper/` | Hyperledger Caliper benchmark definitions, network configuration, and the JavaScript workload module for `RegisterEvidence`. |
| `analysis/` | Python scripts for descriptive statistics, Welch t-tests with Holm–Bonferroni correction, BCa bootstrap confidence intervals, and figure generation. |
| `results/` | Empty directory where benchmark outputs are written. |
| `figures/` | Generated PDF figures matching those in the paper. |
| `docs/` | Extended documentation for the protocols described in the paper's appendices. |

## Prerequisites

- **Docker** ≥ 20.10 and **Docker Compose** ≥ 1.29
- **Hyperledger Fabric** v2.5.9 binaries (`peer`, `orderer`, `configtxgen`, `cryptogen`)
- **Hyperledger Caliper** v0.6.0
- **Go** ≥ 1.20 (for chaincode compilation)
- **Node.js** ≥ 18 (for the Caliper workload module)
- **Python** ≥ 3.11 with the packages listed in `requirements.txt`
- A host with **8 vCPUs and 32 GB RAM** (the paper's GCP `e2-standard-8` specification)

## Reproduction

### 1. Clone and set up the environment

```bash
git clone https://github.com/iun1xmd5/df.git
cd df
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
