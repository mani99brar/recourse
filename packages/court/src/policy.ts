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
  sha256: '0x5efd65be933b514c8a432d240e5e5bbb7a35bc0e1200849d7bab0290d29286ee',
  cid: 'bafkreic67vs35ez3kfgiuqzneqhf4w53pi23ydqsaccj265lakinfeug5y',
  uri: '/ipfs/bafkreic67vs35ez3kfgiuqzneqhf4w53pi23ydqsaccj265lakinfeug5y',
  size: 5767,
};
