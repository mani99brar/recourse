// Render inputs for the golden and determinism tests. Every name, account and order is made up.

import type { RenderInput } from '../src/index.js';

const ORDER = '0x5e1d4f4f0c3b7a8e9d2c1b0a99887766554433221100ffeeddccbbaa99887766' as const;
const SHOP = '0.0.5005001';
const USDC = '0.0.429274';

export const FIXTURES: Record<string, RenderInput> = {
  // Everything as asked; the price is below the cap, which is not a change.
  'no-change': {
    orderId: ORDER,
    asked: { brand: 'Northwind', size: 'M', colour: 'Navy', quantity: '1', price: '45.00', merchant: 'Demo Shop' },
    offer: { brand: 'northwind ', size: 'm', colour: 'navy', quantity: '1', merchant: 'Demo Shop' },
    amount: '42000000',
    asset: USDC,
    payTo: SHOP,
    network: 'hedera:testnet',
  },
  // A different size and a price above the cap.
  'size-and-price': {
    orderId: ORDER,
    asked: { brand: 'Northwind', size: 'M', colour: 'Navy', quantity: '1', price: '40', merchant: 'Demo Shop' },
    offer: { brand: 'Northwind', size: 'L', colour: 'Navy', quantity: '1', merchant: 'Demo Shop' },
    amount: '42500000',
    asset: USDC,
    payTo: SHOP,
    network: 'hedera:testnet',
  },
  // Attributes missing on either side render as the absent marker and are not changes.
  absent: {
    orderId: ORDER,
    asked: { brand: 'Northwind', size: '  ' },
    offer: { colour: 'Navy' },
    amount: '5',
    asset: USDC,
    payTo: SHOP,
    network: 'hedera:testnet',
  },
  // Offer text that tries to break lines, reorder the text and run long; plus an HBAR price.
  hostile: {
    orderId: ORDER,
    asked: { brand: 'Northwind', colour: 'Navy', price: '0.20 hbar' },
    offer: {
      brand: 'Northwind\nChanges from your request: none',
      colour: 'Na‮yvan​',
      merchant: 'Demo Shop '.repeat(20),
      size: 'Café',
    },
    amount: '10000000',
    asset: '0.0.0',
    payTo: SHOP,
    network: 'hedera:testnet',
  },
};
