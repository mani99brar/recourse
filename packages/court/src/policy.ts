// The court policy document that every template points to. The hash and CID are fixed here so a
// template can be built without reading the file; a test recomputes both from the file's bytes.
// `cid` is the document as one raw IPFS block, so the CID is the same wherever it is pinned.

import type { Hex } from 'viem';

export interface PolicyRecord {
  /** Path from the package root. */
  path: string;
  /** SHA-256 of the file bytes. */
  sha256: Hex;
  /** CIDv1 of the file as one raw block. */
  cid: string;
  /** `/ipfs/<cid>`, the template's `policyURI`. */
  uri: string;
  /** Byte length of the file. */
  size: number;
}

export const POLICY: PolicyRecord = {
  path: 'policy/policy-v1.md',
  sha256: '0x59c50b00799644b71422702233e13b2157b2f362fdbe3717b394940834939d43',
  cid: 'bafkreiczyufqa6mwis3riitqeiz6cozbk6zpgyx5xy3rpm4usqedje45im',
  uri: '/ipfs/bafkreiczyufqa6mwis3riitqeiz6cozbk6zpgyx5xy3rpm4usqedje45im',
  size: 5769,
};
