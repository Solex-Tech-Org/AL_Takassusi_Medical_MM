'use strict';

const cds = require('@sap/cds');

const config = () => cds.env.aaml?.s4 || {};

// Keep the legacy `mode` property working while allowing live SAP reads and
// mock postings to be enabled independently.
const readMode = () => config().readMode || config().mode || 'mock';
const postingMode = () => config().postingMode || config().mode || 'mock';
const casePostingMode = () => config().casePostingMode || postingMode();
const remoteReadsEnabled = () => readMode() === 'remote';
const remotePostingEnabled = scenario => {
    // Case Consumption can be enabled independently; other posting flows keep
    // using the shared postingMode switch unless it is explicitly set to remote.
    const isCase = scenario === 'Normal' || scenario === 'NuclearConsumption';
    return (isCase ? casePostingMode() : postingMode()) === 'remote';
};

module.exports = { readMode, postingMode, casePostingMode, remoteReadsEnabled, remotePostingEnabled };
