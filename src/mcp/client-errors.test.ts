import { expect, test } from 'bun:test';
import { OpenPlodClient } from './client';

const client = (status: number, body: unknown) => new OpenPlodClient('http://127.0.0.1:3487', 'token', async () => Response.json(body, { status }));

test('only revision conflicts are reported as revision conflicts; other 409s keep the vault message', async () => {
  await expect(client(409, { success: false, code: 'revision_conflict', error: 'This item changed elsewhere.' }).request('/api/v1/documents/x', 'PATCH', {}))
    .rejects.toThrow('reload the current revision');
  await expect(client(409, { success: false, code: 'cost_confirmation_required', error: 'Confirm the estimated cost first. Over the per-job threshold.' }).request('/api/v1/jobs', 'POST', {}))
    .rejects.toThrow('Confirm the estimated cost first. Over the per-job threshold. (cost_confirmation_required)');
  await expect(client(409, { success: false, code: 'job_active', error: 'This recording is already being processed.' }).request('/api/v1/jobs', 'POST', {}))
    .rejects.toThrow('already being processed');
});
