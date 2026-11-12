import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiAuthService, resolveAuthOrigin } from './api-auth';

describe('API authentication availability', () => {
  it('keeps root-hosted production sessions first-party while retaining Pages and development API origins', () => {
    expect(resolveAuthOrigin('https://backend.example', true, '/')).toBe('');
    expect(resolveAuthOrigin('=/api', true, '/')).toBe('');
    expect(resolveAuthOrigin('https://backend.example/', true, '/smart-logistics-frontend/')).toBe('https://backend.example');
    expect(resolveAuthOrigin('http://localhost:3001', false, '/')).toBe('http://localhost:3001');
  });
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('ends session bootstrap when the backend never responds', async () => {
    vi.stubGlobal('fetch', vi.fn((_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    })));
    const result = new ApiAuthService().getCurrentUser();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await result).toEqual({ success: false });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports a retryable error for a stalled login', async () => {
    vi.stubGlobal('fetch', vi.fn((_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    })));
    const result = new ApiAuthService().login('user@example.com', 'password');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await result).toEqual({ success: false, error: 'The server took too long to respond. Please try again.' });
  });

  it('keeps session credentials and clears the timeout after a successful response', async () => {
    const user = { id: '1', email: 'user@example.com', name: 'User', role: 'user' };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ user }) });
    vi.stubGlobal('fetch', fetchMock);
    expect(await new ApiAuthService().getCurrentUser()).toEqual({ success: true, user });
    expect(fetchMock.mock.calls[0][1].credentials).toBe('include');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('carries the protected deep link through Onesa sign-in instead of an older saved destination', async () => {
    window.history.replaceState(null, '', '#/supply-chain/shipments/123/tracking?view=events');
    sessionStorage.setItem('imsop:return-to', '#/profile');
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ url: 'http://invalid.example' }) });
    vi.stubGlobal('fetch', fetchMock);
    // Invalid issuer URL stops navigation after the request, allowing request assertions in jsdom.
    await expect(new ApiAuthService().startOnesa()).rejects.toThrow('Invalid Onesa sign-in destination');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).returnTo).toBe('#/supply-chain/shipments/123/tracking?view=events');
    window.history.replaceState(null, '', '#/login?mode=live');
    await expect(new ApiAuthService().startOnesa()).rejects.toThrow('Invalid Onesa sign-in destination');
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).returnTo).toBe('#/profile');
  });
});
