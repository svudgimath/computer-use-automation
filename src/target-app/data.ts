// In-memory "core banking" data. Deliberately not a real DB — this app exists
// only as a proxy target for the automation system, not as a product.

export interface Member {
  id: string;
  name: string;
  status: "active" | "restricted";
  savingsBalanceCents: number;
  checkingBalanceCents: number;
  ssnLast4: string; // stand-in for sensitive PII the system must never persist/log raw
}

export interface SubAccount {
  accountNumber: string;
  memberId: string;
  type: "Savings" | "Checking" | "CD";
  nickname: string;
  initialDepositCents: number;
}

export const members: Record<string, Member> = {
  "10001": {
    id: "10001",
    name: "Dana Whitfield",
    status: "active",
    savingsBalanceCents: 245_000,
    checkingBalanceCents: 88_231,
    ssnLast4: "4471",
  },
  "10002": {
    id: "10002",
    name: "Marcus Aldrin",
    status: "active",
    savingsBalanceCents: 1_204_500,
    checkingBalanceCents: 12_004,
    ssnLast4: "0093",
  },
  // Special IDs used to deliberately exercise runtime/error conditions during
  // discovery and replay (see REPORT.md, section 3 "Determinism & error handling").
  "77777": {
    id: "77777",
    name: "Restricted Test Member",
    status: "restricted",
    savingsBalanceCents: 50_000,
    checkingBalanceCents: 0,
    ssnLast4: "9999",
  },
  "99999": {
    id: "99999",
    name: "Session Timeout Test Member",
    status: "active",
    savingsBalanceCents: 10_000,
    checkingBalanceCents: 0,
    ssnLast4: "0000",
  },
  "88888": {
    id: "88888",
    name: "Slow Load Test Member",
    status: "active",
    savingsBalanceCents: 500_000,
    checkingBalanceCents: 0,
    ssnLast4: "1111",
  },
};

export const subAccounts: SubAccount[] = [];

let nextAccountNumber = 500001;
export function allocateAccountNumber(): string {
  return String(nextAccountNumber++);
}

export function formatUsd(cents: number): string {
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
}
