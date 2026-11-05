import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('config', () => {
  it('defaults to the local store with the documented values', () => {
    const c = loadConfig({});
    expect(c).toMatchObject({ store: 'local', port: 8707, publishThreshold: 20, sampleMode: true, z: 1.96, lifetimeDays: 182, retrySeconds: 600, retryMax: 5, pageSize: 100, reviewsEnabled: false });
  });
  it('the arkiv path switches on with config only, and refuses to start without a key', () => {
    expect(() => loadConfig({ DOCKET_STORE: 'arkiv' })).toThrow(/ARKIV_ACCESS_KEY/);
    expect(loadConfig({ DOCKET_STORE: 'arkiv', ARKIV_ACCESS_KEY: 'k' })).toMatchObject({ store: 'arkiv', arkivAccessKey: 'k' });
  });
  it('rejects bad values by name', () => {
    expect(() => loadConfig({ DOCKET_STORE: 'x' })).toThrow(/DOCKET_STORE/);
    expect(() => loadConfig({ DOCKET_POLL_SECONDS: '0' })).toThrow(/DOCKET_POLL_SECONDS/);
    expect(() => loadConfig({ DOCKET_SAMPLE_MODE: 'maybe' })).toThrow(/DOCKET_SAMPLE_MODE/);
  });
  it('caps the page size at 100', () => {
    expect(loadConfig({ ARKIV_PAGE_SIZE: '500' }).pageSize).toBe(100);
  });
});
