// Contracts this repo does not deploy: KlerosCore, EvidenceModule and the CCIP OffRamp.
import { parseAbi } from 'viem';

export const klerosAbi = parseAbi([
  'function currentRuling(uint256 disputeId) view returns (uint256 ruling, bool tied, bool overridden)',
  'function disputes(uint256 disputeId) view returns (uint96 courtID, address arbitrated, uint8 period, bool ruled, uint256 lastPeriodChange)',
]);

export const evidenceAbi = parseAbi([
  'event Evidence(uint256 indexed _externalDisputeID, address indexed _party, string _evidence)',
]);

export const offRampAbi = parseAbi(['function getExecutionState(bytes32 messageId) view returns (uint8)']);
