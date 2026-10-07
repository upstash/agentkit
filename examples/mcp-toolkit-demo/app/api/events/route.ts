/**
 * Where QStash delivers each event. The handler verifies QStash's signature, signs the envelope
 * with the subscriber's secret, POSTs it, and answers 500 when the host's callback failed so
 * QStash retries with backoff.
 */
import { events } from "../../lib/events";

export const dynamic = "force-dynamic";

export const POST = events.createDeliveryHandler();
