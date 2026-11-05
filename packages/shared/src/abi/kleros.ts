// Kleros v2 on Arbitrum Sepolia: the calls and events this repo uses, taken unchanged (less
// internalType) from the deployment ABIs in @kleros/kleros-v2-contracts 0.12.0, whose addresses
// match the address book. A test checks every item against that package.

/** KlerosCore (proxy). `disputes(id).period`: 0 evidence, 1 commit, 2 vote, 3 appeal, 4 execution. */
export const klerosCoreAbi = [
  {
    type: 'function',
    name: 'arbitrationCost',
    stateMutability: 'view',
    inputs: [{ name: '_extraData', type: 'bytes' }, { name: '_feeToken', type: 'address' }],
    outputs: [{ name: 'cost', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'arbitrationCost',
    stateMutability: 'view',
    inputs: [{ name: '_extraData', type: 'bytes' }],
    outputs: [{ name: 'cost', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'currentRuling',
    stateMutability: 'view',
    inputs: [{ name: '_disputeID', type: 'uint256' }],
    outputs: [
      { name: 'ruling', type: 'uint256' },
      { name: 'tied', type: 'bool' },
      { name: 'overridden', type: 'bool' },
    ],
  },
  {
    type: 'function',
    name: 'disputes',
    stateMutability: 'view',
    inputs: [{ name: '', type: 'uint256' }],
    outputs: [
      { name: 'courtID', type: 'uint96' },
      { name: 'arbitrated', type: 'address' },
      { name: 'period', type: 'uint8' },
      { name: 'ruled', type: 'bool' },
      { name: 'lastPeriodChange', type: 'uint256' },
    ],
  },
  {
    type: 'function',
    name: 'getNumberOfRounds',
    stateMutability: 'view',
    inputs: [{ name: '_disputeID', type: 'uint256' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'getRoundInfo',
    stateMutability: 'view',
    inputs: [{ name: '_disputeID', type: 'uint256' }, { name: '_round', type: 'uint256' }],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: 'disputeKitID', type: 'uint256' },
          { name: 'pnkAtStakePerJuror', type: 'uint256' },
          { name: 'totalFeesForJurors', type: 'uint256' },
          { name: 'nbVotes', type: 'uint256' },
          { name: 'repartitions', type: 'uint256' },
          { name: 'pnkPenalties', type: 'uint256' },
          { name: 'drawnJurors', type: 'address[]' },
          { name: 'sumFeeRewardPaid', type: 'uint256' },
          { name: 'sumPnkRewardPaid', type: 'uint256' },
          { name: 'feeToken', type: 'address' },
          { name: 'drawIterations', type: 'uint256' },
        ],
      },
    ],
  },
  {
    type: 'function',
    name: 'appealPeriod',
    stateMutability: 'view',
    inputs: [{ name: '_disputeID', type: 'uint256' }],
    outputs: [{ name: 'start', type: 'uint256' }, { name: 'end', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'appealCost',
    stateMutability: 'view',
    inputs: [{ name: '_disputeID', type: 'uint256' }],
    outputs: [{ name: 'cost', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'getTimesPerPeriod',
    stateMutability: 'view',
    inputs: [{ name: '_courtID', type: 'uint96' }],
    outputs: [{ name: 'timesPerPeriod', type: 'uint256[4]' }],
  },
  {
    type: 'function',
    name: 'passPeriod',
    stateMutability: 'nonpayable',
    inputs: [{ name: '_disputeID', type: 'uint256' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'draw',
    stateMutability: 'nonpayable',
    inputs: [{ name: '_disputeID', type: 'uint256' }, { name: '_iterations', type: 'uint256' }],
    outputs: [{ name: 'nbDrawnJurors', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'executeRuling',
    stateMutability: 'nonpayable',
    inputs: [{ name: '_disputeID', type: 'uint256' }],
    outputs: [],
  },
  {
    type: 'event',
    name: 'DisputeCreation',
    anonymous: false,
    inputs: [
      { name: '_disputeID', type: 'uint256', indexed: true },
      { name: '_arbitrable', type: 'address', indexed: true },
    ],
  },
  {
    type: 'event',
    name: 'NewPeriod',
    anonymous: false,
    inputs: [
      { name: '_disputeID', type: 'uint256', indexed: true },
      { name: '_period', type: 'uint8', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'Draw',
    anonymous: false,
    inputs: [
      { name: '_address', type: 'address', indexed: true },
      { name: '_disputeID', type: 'uint256', indexed: true },
      { name: '_roundID', type: 'uint256', indexed: false },
      { name: '_voteID', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'AppealPossible',
    anonymous: false,
    inputs: [
      { name: '_disputeID', type: 'uint256', indexed: true },
      { name: '_arbitrable', type: 'address', indexed: true },
    ],
  },
  {
    type: 'event',
    name: 'AppealDecision',
    anonymous: false,
    inputs: [
      { name: '_disputeID', type: 'uint256', indexed: true },
      { name: '_arbitrable', type: 'address', indexed: true },
    ],
  },
  {
    type: 'event',
    name: 'Ruling',
    anonymous: false,
    inputs: [
      { name: '_arbitrable', type: 'address', indexed: true },
      { name: '_disputeID', type: 'uint256', indexed: true },
      { name: '_ruling', type: 'uint256', indexed: false },
    ],
  },
] as const;

/** SortitionModule (proxy). `phase()`: 0 staking, 1 generating, 2 drawing. */
export const sortitionModuleAbi = [
  {
    type: 'function',
    name: 'phase',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint8' }],
  },
  {
    type: 'function',
    name: 'passPhase',
    stateMutability: 'nonpayable',
    inputs: [],
    outputs: [],
  },
  {
    type: 'function',
    name: 'lastPhaseChange',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'minStakingTime',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'maxDrawingTime',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'disputesWithoutJurors',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'event',
    name: 'NewPhase',
    anonymous: false,
    inputs: [{ name: '_phase', type: 'uint8', indexed: false }],
  },
] as const;

/** EvidenceModule (proxy). `_externalDisputeID` is `externalIdUint`. */
export const evidenceModuleAbi = [
  {
    type: 'function',
    name: 'submitEvidence',
    stateMutability: 'nonpayable',
    inputs: [
      { name: '_externalDisputeID', type: 'uint256' },
      { name: '_evidence', type: 'string' },
    ],
    outputs: [],
  },
  {
    type: 'event',
    name: 'Evidence',
    anonymous: false,
    inputs: [
      { name: '_externalDisputeID', type: 'uint256', indexed: true },
      { name: '_party', type: 'address', indexed: true },
      { name: '_evidence', type: 'string', indexed: false },
    ],
  },
] as const;

/** DisputeKitClassic (proxy): appeal funding and vote events. */
export const disputeKitClassicAbi = [
  {
    type: 'event',
    name: 'Contribution',
    anonymous: false,
    inputs: [
      { name: '_coreDisputeID', type: 'uint256', indexed: true },
      { name: '_coreRoundID', type: 'uint256', indexed: true },
      { name: '_choice', type: 'uint256', indexed: false },
      { name: '_contributor', type: 'address', indexed: true },
      { name: '_amount', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'ChoiceFunded',
    anonymous: false,
    inputs: [
      { name: '_coreDisputeID', type: 'uint256', indexed: true },
      { name: '_coreRoundID', type: 'uint256', indexed: true },
      { name: '_choice', type: 'uint256', indexed: true },
    ],
  },
  {
    type: 'event',
    name: 'VoteCast',
    anonymous: false,
    inputs: [
      { name: '_coreDisputeID', type: 'uint256', indexed: true },
      { name: '_juror', type: 'address', indexed: true },
      { name: '_voteIDs', type: 'uint256[]', indexed: false },
      { name: '_choice', type: 'uint256', indexed: true },
      { name: '_justification', type: 'string', indexed: false },
    ],
  },
] as const;
