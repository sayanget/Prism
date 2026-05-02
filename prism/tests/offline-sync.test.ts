import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { syncPendingReports, forceSync, getSyncStatus } from '../src/lib/offline/sync';
import * as dbLib from '../src/lib/offline/db';
import { authService } from '../src/lib/auth';

// Mock Auth service
vi.mock('../src/lib/auth', () => ({
  authService: {
    getAuthHeader: vi.fn(() => ({ Authorization: 'Bearer mock-token' })),
  },
}));

describe('Synchronization Logic (sync.ts)', () => {
  const mockFetch = vi.fn();
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.resetAllMocks();
    global.fetch = mockFetch;
    
    // Explicitly mock dbLib functions for each test to avoid "not defined" or hoisted issues
    vi.spyOn(dbLib, 'isOnline').mockReturnValue(true);
    vi.spyOn(dbLib, 'getPendingReports').mockResolvedValue([]);
    vi.spyOn(dbLib, 'updateReportStatus').mockResolvedValue(undefined);
    vi.spyOn(dbLib, 'removePendingReport').mockResolvedValue(undefined);
    vi.spyOn(dbLib, 'storeSyncedReport').mockResolvedValue(undefined);
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('should skip sync when offline', async () => {
    vi.mocked(dbLib.isOnline).mockReturnValue(false);

    const result = await syncPendingReports();
    expect(result.total).toBe(0);
    expect(dbLib.getPendingReports).not.toHaveBeenCalled();
  });

  it('should report correct sync status', () => {
    vi.mocked(dbLib.isOnline).mockReturnValue(true);
    const status = getSyncStatus();
    expect(status.isOnline).toBe(true);
    expect(status.syncInProgress).toBe(false);
  });

  describe('Sync execution', () => {
    it('should sync pending reports successfully', async () => {
      const mockReports = [
        {
          id: '1',
          latitude: 10,
          longitude: 20,
          digipin: 'PIN1',
          imageDataUrl: 'data:image/jpeg;base64,abc',
          timestamp: 123456,
          retryCount: 0,
          status: 'pending',
        },
      ];

      vi.mocked(dbLib.getPendingReports).mockResolvedValue(mockReports as dbLib.PendingReport[]);
      
      // Mock image blob conversion fetch
      mockFetch.mockResolvedValueOnce({
        blob: () => Promise.resolve(new Blob(['image'], { type: 'image/jpeg' })),
      });

      // Mock API upload fetch
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ id: 'server-id-123' }),
      });

      const result = await syncPendingReports();

      expect(result.synced).toBe(1);
      expect(result.total).toBe(1);
      expect(dbLib.updateReportStatus).toHaveBeenCalledWith('1', 'syncing');
      expect(dbLib.storeSyncedReport).toHaveBeenCalled();
      expect(dbLib.removePendingReport).toHaveBeenCalledWith('1');
    });

    it('should handle API failure and increment retry count', async () => {
      const mockReports = [
        {
          id: '2',
          latitude: 10,
          longitude: 20,
          digipin: 'PIN2',
          imageDataUrl: 'data:image/jpeg;base64,abc',
          timestamp: 123456,
          retryCount: 1,
          status: 'pending',
        },
      ];

      vi.mocked(dbLib.getPendingReports).mockResolvedValue(mockReports as dbLib.PendingReport[]);
      
      mockFetch.mockResolvedValueOnce({
        blob: () => Promise.resolve(new Blob(['image'], { type: 'image/jpeg' })),
      });

      // Mock API Failure
      mockFetch.mockResolvedValueOnce({
        ok: false,
        text: () => Promise.resolve('Internal Server Error'),
      });

      const result = await syncPendingReports();

      expect(result.failed).toBe(1);
      expect(dbLib.updateReportStatus).toHaveBeenCalledWith('2', 'syncing');
      // Second call to update status back to pending with error message
      expect(dbLib.updateReportStatus).toHaveBeenCalledWith(
        '2', 
        'pending', 
        expect.stringContaining('Sync failed')
      );
    });

    it('should mark as failed after exceeding max retries', async () => {
      const mockReports = [
        {
          id: '3',
          latitude: 10,
          longitude: 20,
          digipin: 'PIN3',
          imageDataUrl: 'data:image/jpeg;base64,abc',
          timestamp: 123456,
          retryCount: 5, // SYNC_CONFIG.maxRetries is 5
          status: 'pending',
        },
      ];

      vi.mocked(dbLib.getPendingReports).mockResolvedValue(mockReports as dbLib.PendingReport[]);

      const result = await syncPendingReports();

      expect(result.failed).toBe(1);
      expect(dbLib.updateReportStatus).toHaveBeenCalledWith('3', 'failed', 'Max retries exceeded');
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });
});
