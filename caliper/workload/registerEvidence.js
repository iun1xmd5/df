'use strict';

const { WorkloadModuleBase } = require('@hyperledger/caliper-core');
const crypto = require('crypto');

class RegisterEvidenceWorkload extends WorkloadModuleBase {
    constructor() {
        super();
        this.txIndex = 0;
        this.runPrefix = 'run-0';
    }

    async initializeWorkloadModule(workerIndex, totalWorkers, roundIndex, roundArguments, sutAdapter, sutContext) {
        await super.initializeWorkloadModule(workerIndex, totalWorkers, roundIndex, roundArguments, sutAdapter, sutContext);
        this.runPrefix = roundArguments.perRunPrefix || 'run-0';
    }

    async submitTransaction() {
        this.txIndex++;
        const evidenceID = `${this.runPrefix}-${this.workerIndex}-${this.txIndex}`;
        const description = `Evidence item ${evidenceID}`;
        const timestamp = new Date().toISOString();
        const hash = crypto
            .createHash('sha256')
            .update(`${description}|${timestamp}`)
            .digest('hex');

        const request = {
            contractId: 'evidence-contract',
            contractFunction: 'RegisterEvidence',
            invokerIdentity: 'User1@org1.example.com',
            contractArguments: [
                evidenceID,
                `case-${this.workerIndex}`,
                'device-extraction',
                description,
                hash,
                '',                 // IPFS CID (off critical path)
                'registered',
                `officer-${this.workerIndex}`,
            ],
            readOnly: false,
        };
        await this.sutAdapter.sendRequests(request);
    }
}

function createWorkloadModule() {
    return new RegisterEvidenceWorkload();
}

module.exports.createWorkloadModule = createWorkloadModule;
