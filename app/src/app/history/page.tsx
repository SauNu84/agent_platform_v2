/**
 * Session History page — per-user activity timeline (read-model over session +
 * analysis). Server component reads the projection for the current user; the
 * client table adds filtering + Analyze / Restore / Export CSV actions.
 */
import { getStore } from '@/db';
import { listSessionHistory } from '@/services/history';
import { getMeterState } from '@/services/meter';
import { currentUserId, DEMO_USER_ID } from '@/services/current-user';
import HistoryTable from '@/components/HistoryTable';

export const dynamic = 'force-dynamic';

export default async function HistoryPage() {
  const store = getStore();
  const userId = currentUserId();
  const [rows, meter] = await Promise.all([
    listSessionHistory(store, userId),
    getMeterState(store, userId),
  ]);

  return (
    <div>
      <h1>Session History</h1>
      <p className="subtitle">
        Your practice sessions{userId === DEMO_USER_ID ? ' (demo user)' : ''} · {meter.usedMinutes.toFixed(1)} of{' '}
        {meter.capMinutes.toFixed(0)} voice minutes used ({meter.plan} plan).
      </p>
      <HistoryTable initialRows={rows} />
    </div>
  );
}
