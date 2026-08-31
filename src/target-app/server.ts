import { loadDotEnv } from "../config/env.js";
loadDotEnv();

import express from "express";
import cookieParser from "cookie-parser";
import crypto from "node:crypto";
import {
  members,
  subAccounts,
  allocateAccountNumber,
  type Member,
} from "./data.js";
import {
  loginPage,
  searchPage,
  memberNotFoundPage,
  sessionExpiredPage,
  memberDetailPage,
  newSubAccountForm,
  confirmSubAccountPage,
  subAccountSuccessPage,
  permissionDeniedPage,
} from "./templates.js";

// Deliberately reproduces the runtime conditions the brief calls out (section
// 1 / 3.3): validation errors, "record not found," permission denial, an
// unexpected interstitial (session expiry), and transient slowness. Nothing
// here needs to be a *good* app -- it needs to be a small, honest stand-in
// for the class of legacy surface this system targets. See REPORT.md.

const PORT = Number(process.env.TARGET_APP_PORT ?? 4000);

interface Session {
  loggedIn: boolean;
}
const sessions = new Map<string, Session>();

// Process-level: which member IDs have already triggered a one-time simulated
// session timeout, so the demo doesn't loop forever on repeated visits.
const timeoutAlreadyTriggered = new Set<string>();

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());

app.use((req, res, next) => {
  let sid = req.cookies["ccbc_session"];
  if (!sid || !sessions.has(sid)) {
    sid = crypto.randomUUID();
    sessions.set(sid, { loggedIn: false });
    res.cookie("ccbc_session", sid, { httpOnly: true });
  }
  (req as any).session = sessions.get(sid)!;
  next();
});

function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  const session: Session = (req as any).session;
  if (!session.loggedIn) {
    const returnTo = encodeURIComponent(req.originalUrl);
    res.redirect(`/login?returnTo=${returnTo}`);
    return;
  }
  next();
}

app.get("/", (_req, res) => res.redirect("/members/search"));

app.get("/login", (req, res) => {
  res.send(loginPage());
});

app.post("/login", (req, res) => {
  const session: Session = (req as any).session;
  const { username, password } = req.body as { username?: string; password?: string };
  if (!username || !password) {
    res.status(200).send(loginPage("Username and password are required."));
    return;
  }
  session.loggedIn = true;
  const returnTo = typeof req.query.returnTo === "string" ? req.query.returnTo : "/members/search";
  res.redirect(returnTo);
});

app.get("/members/search", requireAuth, (req, res) => {
  const memberId = typeof req.query.memberId === "string" ? req.query.memberId.trim() : "";
  if (!memberId) {
    res.send(searchPage());
    return;
  }
  res.redirect(`/members/${encodeURIComponent(memberId)}`);
});

app.get("/session-expired", (req, res) => {
  const returnTo = typeof req.query.returnTo === "string" ? req.query.returnTo : "/members/search";
  res.status(200).send(sessionExpiredPage(returnTo));
});

app.get("/members/:id", requireAuth, async (req, res) => {
  const id = req.params.id;
  const member = members[id];

  if (!member) {
    res.status(404).send(memberNotFoundPage(id));
    return;
  }

  // Simulated one-time session timeout / unexpected interstitial. Redirects
  // to a distinct URL (as a real timeout would) rather than rendering
  // in-place, so a checkpoint asserting "URL matches the member page"
  // correctly fails to match instead of silently passing.
  if (id === "99999" && !timeoutAlreadyTriggered.has(id)) {
    timeoutAlreadyTriggered.add(id);
    const session: Session = (req as any).session;
    session.loggedIn = false;
    res.redirect(`/session-expired?returnTo=${encodeURIComponent(req.originalUrl)}`);
    return;
  }

  // Simulated transient slow load.
  if (id === "88888") {
    await new Promise((r) => setTimeout(r, 3000));
  }

  res.send(memberDetailPage(member));
});

app.get("/members/:id/sub-account/new", requireAuth, (req, res) => {
  const member = members[req.params.id];
  if (!member) {
    res.status(404).send(memberNotFoundPage(req.params.id));
    return;
  }
  if (member.status !== "active") {
    res.status(403).send(permissionDeniedPage(member));
    return;
  }
  res.send(newSubAccountForm(member));
});

app.post("/members/:id/sub-account", requireAuth, (req, res) => {
  const member = members[req.params.id];
  if (!member) {
    res.status(404).send(memberNotFoundPage(req.params.id));
    return;
  }
  if (member.status !== "active") {
    res.status(403).send(permissionDeniedPage(member));
    return;
  }

  const { accountType, initialDeposit, nickname } = req.body as {
    accountType?: string;
    initialDeposit?: string;
    nickname?: string;
  };

  const depositValue = Number(initialDeposit);
  const validTypes = ["Savings", "Checking", "CD"];
  if (!accountType || !validTypes.includes(accountType)) {
    res
      .status(200)
      .send(newSubAccountForm(member, { error: "Select a valid account type.", values: { accountType, initialDeposit, nickname } }));
    return;
  }
  if (!initialDeposit || Number.isNaN(depositValue) || depositValue <= 0) {
    res
      .status(200)
      .send(
        newSubAccountForm(member, {
          error: "Initial deposit is required and must be a positive number.",
          values: { accountType, initialDeposit, nickname },
        })
      );
    return;
  }

  res.send(
    confirmSubAccountPage(member, {
      accountType,
      initialDeposit: String(depositValue),
      nickname: nickname ?? "",
    })
  );
});

app.post("/members/:id/sub-account/confirm", requireAuth, (req, res) => {
  const member = members[req.params.id];
  if (!member) {
    res.status(404).send(memberNotFoundPage(req.params.id));
    return;
  }
  if (member.status !== "active") {
    res.status(403).send(permissionDeniedPage(member));
    return;
  }

  const { accountType, initialDeposit, nickname } = req.body as {
    accountType: "Savings" | "Checking" | "CD";
    initialDeposit: string;
    nickname: string;
  };

  const account = {
    accountNumber: allocateAccountNumber(),
    memberId: member.id,
    type: accountType,
    nickname: nickname ?? "",
    initialDepositCents: Math.round(Number(initialDeposit) * 100),
  };
  subAccounts.push(account);

  res.send(subAccountSuccessPage(member, account));
});

app.listen(PORT, () => {
  console.log(`[target-app] Community Core Banking Console listening on http://localhost:${PORT}`);
  console.log(`[target-app] seed member IDs: ${Object.keys(members).join(", ")}`);
});
