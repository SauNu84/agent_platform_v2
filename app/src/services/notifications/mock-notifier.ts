/**
 * Deterministic mock notification transports (SAU-273, WS3).
 *
 * No credentials, no network: every send "succeeds" with a deterministic sim id
 * and is captured in an in-memory outbox so tests (and the dev UI) can assert what
 * would have gone out. This is the fail-soft default of the resolver, so the whole
 * confirmation + clinic-notice loop is exercisable offline.
 */
import type {
  NotificationAdapter,
  OutboundMessage,
  DeliveryResult,
  NotificationChannel,
} from './notification-adapter';

export interface SentMessage extends OutboundMessage {
  channel: NotificationChannel;
  providerId: string;
}

// Process-local outbox. Cleared by __resetMockOutbox() in tests.
const OUTBOX: SentMessage[] = [];

export function mockOutbox(): readonly SentMessage[] {
  return OUTBOX;
}

export function __resetMockOutbox(): void {
  OUTBOX.length = 0;
}

class MockNotifier implements NotificationAdapter {
  readonly simulated = true;
  constructor(
    readonly channel: NotificationChannel,
    readonly label: string,
  ) {}

  async send(msg: OutboundMessage): Promise<DeliveryResult> {
    // Deterministic id keyed on the outbox length so tests are reproducible.
    const providerId = `sim-${this.channel}-${OUTBOX.length + 1}`;
    OUTBOX.push({ ...msg, channel: this.channel, providerId });
    return { ok: true, providerId, simulated: true };
  }
}

export class MockSmsAdapter extends MockNotifier {
  constructor() {
    super('sms', 'Simulated SMS');
  }
}

export class MockEmailAdapter extends MockNotifier {
  constructor() {
    super('email', 'Simulated email');
  }
}
