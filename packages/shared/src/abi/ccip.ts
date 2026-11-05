// CCIP OffRamp 2.0.0 (both lanes): taken unchanged (less internalType) from
// @chainlink/contracts-ccip 2.0.0 abi/v2_0_0/offramp.json. A test checks every item against it.

/** `getExecutionState(messageId)`: 0 untouched, 1 in progress, 2 success, 3 failure. */
export const ccipOffRampAbi = [
  {
    type: 'function',
    name: 'getExecutionState',
    stateMutability: 'view',
    inputs: [{ name: 'messageId', type: 'bytes32' }],
    outputs: [{ name: '', type: 'uint8' }],
  },
  {
    type: 'function',
    name: 'typeAndVersion',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'string' }],
  },
  {
    type: 'event',
    name: 'ExecutionStateChanged',
    anonymous: false,
    inputs: [
      { name: 'sourceChainSelector', type: 'uint64', indexed: true },
      { name: 'messageNumber', type: 'uint64', indexed: true },
      { name: 'messageId', type: 'bytes32', indexed: true },
      { name: 'state', type: 'uint8', indexed: false },
      { name: 'returnData', type: 'bytes', indexed: false },
    ],
  },
] as const;
