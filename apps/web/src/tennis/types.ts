export type { VenueRecord, CourtRecord, SavedDiscount } from "../../../../packages/db/src/tennis/catalog";
export type { QuoteRecord, OrderLine, OrderRecord } from "../../../../packages/db/src/tennis/booking";
export type { CustomerRecord } from "../../../../packages/db/src/tennis/customers";
export type { PaymentRecord } from "../../../../packages/db/src/tennis/payments";
export type { RefundRecord } from "../../../../packages/db/src/tennis/refunds";
export type { TopupOffer, TopupQuote, TopupPayment } from "../../../../packages/db/src/tennis/topups";
export type { WalletBalance } from "../../../../packages/db/src/tennis/wallet-store";
import type { VenueRecord, CourtRecord } from "../../../../packages/db/src/tennis/catalog";
import type { OrderRecord, OrderLine } from "../../../../packages/db/src/tennis/booking";
import type { PaymentRecord } from "../../../../packages/db/src/tennis/payments";
import type { RefundRecord } from "../../../../packages/db/src/tennis/refunds";
import type { WalletBalance } from "../../../../packages/db/src/tennis/wallet-store";

export interface Session {
  subjectId: string;
  displayName: string;
  csrfToken: string;
  tenantId: string | null;
  kind: "staff" | "customer" | "platform";
  platformOperator: boolean;
  contextVersion: number;
  permissions: string[];
  allVenues: boolean;
  venueIds: string[];
  customerId: string | null;
  expiresAt: string;
  tenants: { id: string; name: string; kind: "staff" | "customer"; role?: string }[];
  localSimulation?: boolean;
  contextValid?: boolean;
}
export interface Schedule {
  venue: VenueRecord;
  courts: CourtRecord[];
  occupancies: {
    id: string;
    courtId: string;
    startAt: string;
    endAt: string;
    kind: string;
    orderId?: string | null;
    customerName?: string | null;
    status?: string;
  }[];
}
export interface Wallet {
  balance: WalletBalance;
  entries: {
    id: string;
    kind: string;
    principalCents: number;
    giftCents: number;
    sourceId: string;
    createdAt: string;
  }[];
}
export interface OrderDetail extends OrderRecord {
  lines: (OrderLine & { remainingRefundCents?: number })[];
  customerName?: string;
  payments?: PaymentRecord[];
  refunds?: RefundRecord[];
}
export interface SelectionLine {
  courtId: string;
  startAt: string;
  endAt: string;
}
export interface CommandReceipt {
  commandType: string;
  result: Record<string, unknown>;
  completedAt: string;
}
export interface TenantRecord {
  id: string;
  name: string;
  active: boolean;
  createdAt?: string;
}
export interface AiConfiguration {
  enabled: boolean;
  model: string;
  baseUrl: string;
  externalAgentUrl: string;
  hasApiKey?: boolean;
  revision?: number;
}
export interface AssistantStatus {
  configured: boolean;
  enabled?: boolean;
  message?: string;
}
export interface AssistantReply {
  message: string;
  requestId?: string;
  entries?: { label: string; page: string; orderId?: string }[];
}

export function permits(session: Session, permission: string): boolean {
  if (session.kind === "platform") return false;
  return (
    session.kind === "staff" &&
    (session.permissions?.includes(permission) ||
      session.tenants.some((t) => t.id === session.tenantId && t.kind === "staff" && t.role === "ADMIN"))
  );
}
