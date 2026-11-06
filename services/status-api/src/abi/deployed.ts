// The generated ABIs in deployments/abi, as the actions encode calls and decode reverts with them.
// The event and view fragments beside this file stay the decoder's; these are the whole interfaces,
// every function and every custom error, so any call the contract takes builds and any revert decodes.

import type { Abi } from 'viem';
import { erc20Abi } from 'viem';
import { evidenceModuleAbi } from '@recourse/shared';
import claimsJson from '../../../../deployments/abi/RecourseClaims.json' with { type: 'json' };
import vaultJson from '../../../../deployments/abi/DepositVault.json' with { type: 'json' };
import caseJson from '../../../../deployments/abi/RecourseCase.json' with { type: 'json' };

export const CLAIMS_ABI = claimsJson as unknown as Abi;
export const VAULT_ABI = vaultJson as unknown as Abi;
export const CASE_ABI = caseJson as unknown as Abi;
/** The vault token's ERC-20 face: allowance, balance and approve. */
export const TOKEN_ABI = erc20Abi as Abi;
export const EVIDENCE_ABI = evidenceModuleAbi as unknown as Abi;

/** Contract names as the API shows them (`call.contract`, `details.revert.contract`). */
export type ContractLabel = 'RecourseClaims' | 'DepositVault' | 'RecourseCase' | 'EvidenceModule' | 'VaultToken';

export const ABI_OF: Record<ContractLabel, Abi> = {
  RecourseClaims: CLAIMS_ABI,
  DepositVault: VAULT_ABI,
  RecourseCase: CASE_ABI,
  EvidenceModule: EVIDENCE_ABI,
  VaultToken: TOKEN_ABI,
};
