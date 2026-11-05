// The agent's approval API, read-only. A pending approval shows exactly what the buyer is asked to
// sign: the rendered text, its hash, the amount and payee, and the render input so any page can
// render the text again and compare the hash. The buyer decides with the `approve` command, which
// signs with the buyer key and records the decision; this service never holds that key.

import express, { type Express } from 'express';
import type { Hex } from 'viem';
import { render } from '@recourse/renderer';
import type { Logger } from '@recourse/records';
import { APPROVAL_DOMAIN, APPROVAL_TYPES, type ApprovalMessage } from './approval.js';
import { orderOfApproval, pendingApprovalOf, type AgentRow } from './buy.js';

export interface ApprovalsApiDeps {
  /** A fresh read of the order journal, taken for each request. */
  rows: () => readonly AgentRow[];
  log: Logger;
  now?: () => number;
}

export function approvalMessage(orderId: Hex, p: NonNullable<ReturnType<typeof pendingApprovalOf>>, decision: ApprovalMessage['decision']): ApprovalMessage {
  return { orderId, textHash: p.rendered.textHash, amount: p.terms.amount, payTo: p.terms.payTo, decision, expiresAt: p.expiresAt };
}

export function createApprovalsApi(deps: ApprovalsApiDeps): Express {
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');
  app.use(express.json({ limit: '2kb' }));

  app.get('/health', (_req, res) => {
    res.json({ ok: true, service: 'agent' });
  });

  app.get('/approvals/:approvalId', (req, res) => {
    const rows = deps.rows();
    const orderId = orderOfApproval(rows, req.params.approvalId);
    const pending = orderId ? pendingApprovalOf(rows, orderId) : null;
    if (!orderId || !pending) {
      res.status(404).json({ error: 'approval_not_found' });
      return;
    }
    const text = render(pending.rendered.renderInput).text;
    res.json({
      approvalId: pending.approvalId,
      orderId,
      expiresAt: pending.expiresAt,
      expired: now() > pending.expiresAt,
      text,
      textHash: pending.rendered.textHash,
      amount: pending.terms.amount,
      asset: pending.terms.asset,
      payTo: pending.terms.payTo,
      network: pending.terms.network,
      renderInput: pending.rendered.renderInput,
      rendererVersion: pending.rendered.rendererVersion,
      typedData: {
        domain: APPROVAL_DOMAIN,
        types: APPROVAL_TYPES,
        primaryType: 'RecourseApproval',
        message: approvalMessage(orderId, pending, 'approved'),
      },
      command: `pnpm --filter @recourse/agent approve ${pending.approvalId}`,
    });
  });

  return app;
}
