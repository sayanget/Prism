import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import {
  initOfflineDB,
  storeReportOffline,
  getPendingReports,
  updateReportStatus,
  removePendingReport,
  storeSyncedReport,
  cacheMedia,
  getCachedMedia,
  getCacheSize,
  checkAndEvictIfNeeded,
  storeBountyClaim,
  getActiveBountyClaim,
  clearExpiredClaims,
  clearAllOfflineData,
  getDB
} from '../src/lib/offline/db';

describe('Offline Database (db.ts)', () => {
  beforeEach(async () => {
    // Ensure we start with a clean database for each test
    await clearAllOfflineData();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Report Management', () => {
    it('should store and retrieve offline reports', async () => {
      const report = {
        latitude: 12.34,
        longitude: 56.78,
        digipin: 'ABC123',
        imageDataUrl: 'data:image/jpeg;base64,mock',
        timestamp: Date.now(),
      };

      const id = await storeReportOffline(report);
      expect(id).toBeDefined();

      const pending = await getPendingReports();
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({
        ...report,
        id,
        retryCount: 0,
        status: 'pending',
      });
    });

    it('should update report status and retry count', async () => {
      const report = {
        latitude: 0,
        longitude: 0,
        digipin: 'TEST',
        imageDataUrl: 'data:image/png;base64,mock',
        timestamp: Date.now(),
      };

      const id = await storeReportOffline(report);

      // Update to syncing (should increment retryCount)
      await updateReportStatus(id, 'syncing');
      let updated = (await getPendingReports())[0];
      expect(updated.status).toBe('syncing');
      expect(updated.retryCount).toBe(1);

      // Update with error
      await updateReportStatus(id, 'failed', 'Network error');
      updated = (await getPendingReports())[0];
      expect(updated.status).toBe('failed');
      expect(updated.lastError).toBe('Network error');
    });

    it('should remove pending reports', async () => {
      const id = await storeReportOffline({
        latitude: 0,
        longitude: 0,
        digipin: 'TEST',
        imageDataUrl: 'data:mock',
        timestamp: Date.now(),
      });

      await removePendingReport(id);
      const pending = await getPendingReports();
      expect(pending).toHaveLength(0);
    });

    it('should store synced reports', async () => {
      const syncedReport = {
        id: 'local-123',
        serverId: 'server-456',
        latitude: 1.1,
        longitude: 2.2,
        digipin: 'SYNCED',
        syncedAt: Date.now(),
        localId: 'local-123',
      };

      await storeSyncedReport(syncedReport);
      const db = await getDB();
      const stored = await db.get('synced_reports', 'local-123');
      expect(stored).toEqual(syncedReport);
    });
  });

  describe('Media Cache', () => {
    it('should cache and retrieve media', async () => {
      const blob = new Blob(['hello world'], { type: 'text/plain' });
      const id = await cacheMedia(blob, 'report-1');

      const cached = await getCachedMedia(id);
      expect(cached).toBeDefined();
      expect(cached?.size).toBe(blob.size);
      expect(cached?.reportId).toBe('report-1');
      
      // Since JSDOM/IDB might not preserve Blob prototype perfectly in all environments, 
      // we check size as evidence of content if text() fails.
      expect(cached?.blob).toBeDefined();
    });

    it('should calculate total cache size', async () => {
      await cacheMedia(new Blob(['abc']), '1'); // 3 bytes
      await cacheMedia(new Blob(['defgh']), '2'); // 5 bytes

      const totalSize = await getCacheSize();
      expect(totalSize).toBe(8);
    });

    it('should evict media when quota is exceeded', async () => {
      // Add multiple items
      await cacheMedia(new Blob(['oldest']), '1');
      // Ensure different timestamps if implementation uses them
      await new Promise(r => setTimeout(r, 10)); 
      await cacheMedia(new Blob(['newest']), '2');

      const maxBytes = 10;
      // 80% threshold of 10 is 8 bytes.
      // 'oldest' is 6 bytes, 'newest' is 6 bytes. Total 12 > 8.
      // Should evict 'oldest' until under 7 bytes (70% of 10).
      
      await checkAndEvictIfNeeded(maxBytes);

      const db = await getDB();
      const all = await db.getAll('media_cache');
      expect(all).toHaveLength(1);
    });
  });

  describe('Bounty Claims', () => {
    it('should store and retrieve active bounty claims', async () => {
      const future = Date.now() + 10000;
      const claim = {
        id: 'claim-1',
        bountyId: 'bounty-A',
        claimedAt: Date.now(),
        expiresAt: future,
        latitude: 10,
        longitude: 20,
      };

      await storeBountyClaim(claim);

      const active = await getActiveBountyClaim('bounty-A');
      expect(active).toEqual(claim);

      const inactive = await getActiveBountyClaim('non-existent');
      expect(inactive).toBeUndefined();
    });

    it('should filter out expired claims', async () => {
      const past = Date.now() - 1000;
      const claim = {
        id: 'expired-1',
        bountyId: 'bounty-B',
        claimedAt: Date.now() - 5000,
        expiresAt: past,
        latitude: 10,
        longitude: 20,
      };

      await storeBountyClaim(claim);
      
      const active = await getActiveBountyClaim('bounty-B');
      expect(active).toBeUndefined();

      await clearExpiredClaims();
      const db = await getDB();
      const all = await db.getAll('bounty_claims');
      expect(all).toHaveLength(0);
    });
  });
});
