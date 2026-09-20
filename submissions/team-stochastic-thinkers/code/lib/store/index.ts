/**
 * Persistence boundary (README §9). Everything goes through getStore(); only MemoryStore exists because no data
 * layer was purchased (Firebase bid lost). Additions to the README interface: getHelperByPhone (OTP + inbound SMS),
 * listHelpers (ops map), getDispatch (respond), saveRating (§3 "gets rated"), and the money records
 * (payments, reimbursements) that Razorpay settlement and receipt approval are written into.
 */
import type { AuditEntry, Authority, Dispatch, Helper, HelpRequest, LatLng, Otp, Payment, Rating, Reimbursement, StoreErrorReason, UserLocation, Zone } from "../types";
import { MemoryStore } from "./memory";
import { JsonFilePersistence, MongoPersistence } from "./persist";

export type AcceptResult =
  | { ok: true; request: HelpRequest; dispatch: Dispatch; cancelled: Dispatch[] }
  | { ok: false; reason: StoreErrorReason };

/**
 * What markPaymentPaid answers. `alreadyPaid` is the half that matters: Razorpay announces one payment twice (the
 * browser callback and the webhook, in either order), so the caller credits the worker only when it is false.
 */
export type MarkPaidResult =
  | { ok: true; payment: Payment; alreadyPaid: boolean }
  | { ok: false; reason: "not_found" };

export interface Store {
  upsertHelper(h: Helper): Promise<Helper>;
  getHelper(id: string): Promise<Helper | null>;
  getHelperByPhone(phone: string): Promise<Helper | null>;
  listHelpers(): Promise<Helper[]>;
  getOnDutyHelpers(): Promise<Helper[]>;
  setOnDuty(id: string, onDuty: boolean, location?: LatLng | null): Promise<Helper | null>;
  createRequest(r: HelpRequest): Promise<HelpRequest>;
  getRequest(id: string): Promise<HelpRequest | null>;
  updateRequest(id: string, patch: Partial<HelpRequest>): Promise<HelpRequest | null>;
  listOpenRequests(): Promise<HelpRequest[]>;
  createDispatches(ds: Dispatch[]): Promise<Dispatch[]>;
  getDispatch(id: string): Promise<Dispatch | null>;
  listDispatches(requestId: string): Promise<Dispatch[]>;
  listPingedForHelper(helperId: string): Promise<Dispatch[]>;
  updateDispatch(id: string, patch: Partial<Dispatch>): Promise<Dispatch | null>;
  acceptDispatch(dispatchId: string): Promise<AcceptResult>;
  saveRating(r: Rating): Promise<Rating>;
  saveOtp(o: Otp): Promise<void>;
  verifyOtp(phone: string, code: string): Promise<boolean>;

  // Money (lib/money.ts + Razorpay). Append-only: a record is superseded by a new one, never deleted.
  createPayment(p: Payment): Promise<Payment>;
  getPayment(id: string): Promise<Payment | null>;
  getPaymentByOrderId(orderId: string): Promise<Payment | null>;      // the webhook knows the order, not our id
  listPaymentsForRequest(requestId: string): Promise<Payment[]>;      // oldest attempt first
  updatePayment(id: string, patch: Partial<Payment>): Promise<Payment | null>;
  /** The one way a payment reaches "paid". Safe to call twice for the same payment; credits the worker once. */
  markPaymentPaid(id: string, paymentId: string): Promise<MarkPaidResult>;
  createReimbursement(r: Reimbursement): Promise<Reimbursement>;
  getReimbursement(id: string): Promise<Reimbursement | null>;
  listReimbursements(requestId: string): Promise<Reimbursement[]>;    // oldest first
  updateReimbursement(id: string, patch: Partial<Reimbursement>): Promise<Reimbursement | null>;

  // Disaster response (authorities)
  recordLocation(u: Omit<UserLocation, "history">): Promise<UserLocation>;   // upsert by phone, appends to the 24 h trail
  listLocations(): Promise<UserLocation[]>;
  deleteLocation(phone: string): Promise<void>;
  saveZone(z: Zone): Promise<Zone>;
  listZones(): Promise<Zone[]>;
  getAuthority(username: string): Promise<Authority | null>;
  listAuthorities(): Promise<Authority[]>;
  upsertAuthority(a: Authority): Promise<Authority>;
  audit(e: AuditEntry): Promise<void>;
  listAudit(): Promise<AuditEntry[]>;
}

const g = globalThis as unknown as { __resq_store?: Store };

function createStore(): Store {
  const kind = process.env.STORE || "memory";
  if (kind !== "memory") throw new Error(`store adapter "${kind}" not purchased`);
  const f = process.env.RESQ_DATA_FILE?.trim();
  const jsonPath = f === "off" ? null : f || `${process.cwd()}/.data/accounts.json`;
  const mongo = process.env.MONGODB_URI?.trim();
  // MongoDB holds registered users when configured (first start imports the JSON file); otherwise the JSON file.
  const persistence = mongo ? new MongoPersistence(process.env.MONGODB_DB?.trim() || "resq", jsonPath) : jsonPath ? new JsonFilePersistence(jsonPath) : null;
  return new MemoryStore({ persistence });
}

export function getStore(): Store {
  return (g.__resq_store ??= createStore());
}

export function resetStoreForTests(store?: Store): void {
  g.__resq_store = store ?? createStore();
}
