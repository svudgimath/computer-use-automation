import { loadDotEnv } from "../../config/env.js";
loadDotEnv();

import express from "express";
import cookieParser from "cookie-parser";
import crypto from "node:crypto";
import { loginPage, memberDetailPage, memberNotFoundPage } from "../templates.js";

// A second "tenant" running the same underlying vendor product as the base
// target-app -- reusing its login/member-detail templates verbatim (real
// vendor products don't get re-themed field-by-field; they get re-branded
// and re-configured) -- but with its own data, its own branding, and one
// deliberately hostile difference: the member-search field has no
// associated <label> at all, just a bare table cell of text next to an
// unlabeled input. That's not a contrived edge case; it's what "a different
// UI team skinned the same backend differently" produces in practice, and
// it's realistic legacy markup the brief calls out directly.
//
// This exists to make agent/tenantOverride's cross-tenant reuse demo real
// rather than descriptive: see test/crossTenantDemo.ts and REPORT.md
// section 4.

const PORT = Number(process.env.TENANT_B_PORT ?? 4001);
const BRAND = "Northgate Credit Union — Staff Portal";

interface TenantBMember {
  id: string;
  name: string;
  status: "active";
  savingsBalanceCents: number;
  checkingBalanceCents: number;
}

const members: Record<string, TenantBMember> = {
  "20001": { id: "20001", name: "Priya Natarajan", status: "active", savingsBalanceCents: 361_200, checkingBalanceCents: 15_000 },
  "20002": { id: "20002", name: "Elliot Zhao", status: "active", savingsBalanceCents: 98_040, checkingBalanceCents: 5_000 },
};

interface Session {
  loggedIn: boolean;
}
const sessions = new Map<string, Session>();

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());

app.use((req, res, next) => {
  let sid = req.cookies["ntgt_session"];
  if (!sid || !sessions.has(sid)) {
    sid = crypto.randomUUID();
    sessions.set(sid, { loggedIn: false });
    res.cookie("ntgt_session", sid, { httpOnly: true });
  }
  (req as any).session = sessions.get(sid)!;
  next();
});

function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  const session: Session = (req as any).session;
  if (!session.loggedIn) {
    res.redirect(`/login?returnTo=${encodeURIComponent(req.originalUrl)}`);
    return;
  }
  next();
}

app.get("/", (_req, res) => res.redirect("/members/search"));

app.get("/login", (_req, res) => res.send(loginPage(undefined, BRAND)));

app.post("/login", (req, res) => {
  const session: Session = (req as any).session;
  const { username, password } = req.body as { username?: string; password?: string };
  if (!username || !password) {
    res.status(200).send(loginPage("Username and password are required.", BRAND));
    return;
  }
  session.loggedIn = true;
  const returnTo = typeof req.query.returnTo === "string" ? req.query.returnTo : "/members/search";
  res.redirect(returnTo);
});

// Deliberately not reusing templates.ts's searchPage(): this tenant's search form has no <label>
// wrapping or `for`/`id` association at all -- the field name is just adjacent table-cell text.
// There is no accessible name for the input, so no role/name locator can find it; this is the one
// step the base artifact genuinely cannot replay against this tenant without a per-tenant override.
app.get("/members/search", requireAuth, (req, res) => {
  const memberId = typeof req.query.memberId === "string" ? req.query.memberId.trim() : "";
  if (memberId) {
    res.redirect(`/members/${encodeURIComponent(memberId)}`);
    return;
  }
  res.send(`<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Member Search - ${BRAND}</title>
<style>
  body { font-family: Tahoma, Geneva, sans-serif; font-size: 13px; background: #d4d0c8; margin: 0; }
  table.frame { width: 100%; border-collapse: collapse; }
  td.header { background: #143d2b; color: #fff; padding: 6px 10px; font-weight: bold; font-size: 15px; }
  td.content { background: #ffffff; padding: 16px; vertical-align: top; }
  table.lookup td { padding: 4px 8px; }
</style>
</head>
<body>
<table class="frame">
  <tr><td class="header">${BRAND}</td></tr>
  <tr><td class="content">
<table class="data"><tr><td><strong>Member Lookup</strong></td></tr></table>
<form method="get" action="/members/search">
  <table class="lookup">
    <tr><td>Account Holder ID</td><td><input type="text" name="memberId"></td></tr>
  </table>
  <button type="submit">Search</button>
</form>
  </td></tr>
</table>
</body>
</html>`);
});

app.get("/members/:id", requireAuth, (req, res) => {
  const member = members[req.params.id];
  if (!member) {
    res.status(404).send(memberNotFoundPage(req.params.id, BRAND));
    return;
  }
  res.send(memberDetailPage(member, BRAND));
});

app.listen(PORT, () => {
  console.log(`[tenant-b] Northgate Credit Union Staff Portal listening on http://localhost:${PORT}`);
  console.log(`[tenant-b] seed member IDs: ${Object.keys(members).join(", ")}`);
});
