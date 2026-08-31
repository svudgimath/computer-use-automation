// Deliberately "legacy" markup: table-based layout, no id/class hooks on
// interactive elements, reused generic class names, inline styles. Accessible
// name/role is still correct (real <button>/<input>/<label> wrapping) because
// that is the one thing legacy enterprise apps usually get right by accident
// (they predate div-soup component libraries) and it's the seam this project's
// locator strategy leans on. See REPORT.md section 2/3.

import type { Member, SubAccount } from "./data.js";
import { formatUsd } from "./data.js";

// Only the fields memberDetailPage actually displays -- deliberately narrower than the full
// Member type so tenantB's member store (which has no ssnLast4) can reuse this template directly
// without inventing a fake field. Member already satisfies this structurally.
type MemberDisplayFields = Pick<Member, "id" | "name" | "status" | "savingsBalanceCents" | "checkingBalanceCents">;

// `brandName` defaults to the base tenant's exact current text -- every existing call site is
// unaffected. It exists so target-app/tenantB (the cross-tenant reuse demo, see
// artifact/tenantOverride.ts) can reuse these same templates under different branding, the way two
// tenants running the same vendor product actually would, without forking this file. See
// REPORT.md section 4.
const DEFAULT_BRAND = "Community Core Banking Console — Internal Use Only";

function layout(title: string, body: string, brandName: string = DEFAULT_BRAND): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${title} - ${brandName}</title>
<style>
  body { font-family: Tahoma, Geneva, sans-serif; font-size: 13px; background: #d4d0c8; margin: 0; }
  table.frame { width: 100%; border-collapse: collapse; }
  td.header { background: #003366; color: #fff; padding: 6px 10px; font-weight: bold; font-size: 15px; }
  td.content { background: #ffffff; padding: 16px; vertical-align: top; }
  table.data { border-collapse: collapse; margin: 8px 0; }
  table.data td, table.data th { border: 1px solid #999; padding: 4px 8px; }
  .banner-error { background: #ffe0e0; border: 1px solid #cc0000; padding: 8px; margin-bottom: 10px; }
  .banner-warn { background: #fff6d5; border: 1px solid #b38f00; padding: 8px; margin-bottom: 10px; }
  .banner-info { background: #e6f2ff; border: 1px solid #336699; padding: 8px; margin-bottom: 10px; }
  label { display: block; margin: 6px 0 2px 0; }
  input, select { font-size: 13px; padding: 2px; }
  button { font-size: 13px; padding: 4px 12px; margin-top: 8px; margin-right: 6px; }
</style>
</head>
<body>
<table class="frame">
  <tr><td class="header">${escapeHtml(brandName)}</td></tr>
  <tr><td class="content">
${body}
  </td></tr>
</table>
</body>
</html>`;
}

export function loginPage(error?: string, brandName?: string): string {
  return layout(
    "Sign In",
    `
${error ? `<div class="banner-error">${error}</div>` : ""}
<table class="data">
<tr><td colspan="2"><strong>Operator Sign In</strong></td></tr>
</table>
<form method="post" action="/login">
  <label>Username <input type="text" name="username" value="operator1"></label>
  <label>Password <input type="password" name="password"></label>
  <button type="submit">Sign In</button>
</form>
`,
    brandName
  );
}

export function searchPage(): string {
  return layout(
    "Member Search",
    `
<table class="data"><tr><td><strong>Member Lookup</strong></td></tr></table>
<form method="get" action="/members/search">
  <label>Member ID <input type="text" name="memberId"></label>
  <button type="submit">Search</button>
</form>
`
  );
}

export function memberNotFoundPage(searchedId: string, brandName?: string): string {
  return layout(
    "Member Not Found",
    `
<div class="banner-warn">No member found matching ID "${escapeHtml(searchedId)}".</div>
<a href="/members/search">Back to Search</a>
`,
    brandName
  );
}

export function sessionExpiredPage(returnTo: string): string {
  return layout(
    "Session Expired",
    `
<div class="banner-error">Your session has expired. Please sign in again to continue.</div>
<form method="post" action="/login?returnTo=${encodeURIComponent(returnTo)}">
  <label>Username <input type="text" name="username" value="operator1"></label>
  <label>Password <input type="password" name="password"></label>
  <button type="submit">Sign In</button>
</form>
`
  );
}

export function memberDetailPage(member: MemberDisplayFields, brandName?: string): string {
  const canOpenSubAccount = member.status === "active";
  return layout(
    "Member Detail",
    `
<table class="data">
<tr><th colspan="2">Member Detail</th></tr>
<tr><td>Member ID</td><td>${member.id}</td></tr>
<tr><td>Name</td><td>${member.name}</td></tr>
<tr><td>Status</td><td>${member.status}</td></tr>
<tr><td>Savings Balance</td><td>${formatUsd(member.savingsBalanceCents)}</td></tr>
<tr><td>Checking Balance</td><td>${formatUsd(member.checkingBalanceCents)}</td></tr>
</table>
${
  canOpenSubAccount
    ? `<form method="get" action="/members/${member.id}/sub-account/new"><button type="submit">Open Sub-Account</button></form>`
    : `<div class="banner-warn">This member's account is restricted. Sub-account creation is not permitted.</div>`
}
<a href="/members/search">Back to Search</a>
`,
    brandName
  );
}

export function permissionDeniedPage(member: Member): string {
  return layout(
    "Permission Denied",
    `
<div class="banner-error">Permission denied. Member ${member.id} is restricted and cannot open new sub-accounts.</div>
<a href="/members/${member.id}">Back to Member</a>
`
  );
}

export function newSubAccountForm(
  member: Member,
  opts?: { error?: string; values?: { accountType?: string; initialDeposit?: string; nickname?: string } }
): string {
  const v = opts?.values ?? {};
  return layout(
    "Open Sub-Account",
    `
${opts?.error ? `<div class="banner-error">${opts.error}</div>` : ""}
<table class="data"><tr><td><strong>Open Sub-Account for ${member.name} (${member.id})</strong></td></tr></table>
<form method="post" action="/members/${member.id}/sub-account">
  <label>Account Type
    <select name="accountType">
      <option value="Savings" ${v.accountType === "Savings" ? "selected" : ""}>Savings</option>
      <option value="Checking" ${v.accountType === "Checking" ? "selected" : ""}>Checking</option>
      <option value="CD" ${v.accountType === "CD" ? "selected" : ""}>CD</option>
    </select>
  </label>
  <label>Initial Deposit (USD) <input type="text" name="initialDeposit" value="${escapeHtml(v.initialDeposit ?? "")}"></label>
  <label>Nickname (optional) <input type="text" name="nickname" value="${escapeHtml(v.nickname ?? "")}"></label>
  <button type="submit">Continue</button>
</form>
<a href="/members/${member.id}">Cancel</a>
`
  );
}

export function confirmSubAccountPage(
  member: Member,
  values: { accountType: string; initialDeposit: string; nickname: string }
): string {
  return layout(
    "Confirm Sub-Account",
    `
<div class="banner-info">Please review before confirming. This action cannot be undone.</div>
<table class="data">
<tr><th colspan="2">Confirm New Sub-Account</th></tr>
<tr><td>Member</td><td>${member.name} (${member.id})</td></tr>
<tr><td>Account Type</td><td>${values.accountType}</td></tr>
<tr><td>Initial Deposit</td><td>$${escapeHtml(values.initialDeposit)}</td></tr>
<tr><td>Nickname</td><td>${escapeHtml(values.nickname) || "(none)"}</td></tr>
</table>
<form method="post" action="/members/${member.id}/sub-account/confirm">
  <input type="hidden" name="accountType" value="${escapeHtml(values.accountType)}">
  <input type="hidden" name="initialDeposit" value="${escapeHtml(values.initialDeposit)}">
  <input type="hidden" name="nickname" value="${escapeHtml(values.nickname)}">
  <button type="submit">Confirm and Open Account</button>
</form>
<form method="get" action="/members/${member.id}">
  <button type="submit">Cancel</button>
</form>
`
  );
}

export function subAccountSuccessPage(member: Member, account: SubAccount): string {
  return layout(
    "Sub-Account Opened",
    `
<div class="banner-info">Sub-account opened successfully.</div>
<table class="data">
<tr><th colspan="2">New Sub-Account</th></tr>
<tr><td>Account Number</td><td>${account.accountNumber}</td></tr>
<tr><td>Member</td><td>${member.name} (${member.id})</td></tr>
<tr><td>Type</td><td>${account.type}</td></tr>
<tr><td>Initial Deposit</td><td>${formatUsd(account.initialDepositCents)}</td></tr>
</table>
<a href="/members/${member.id}">Back to Member</a>
`
  );
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
