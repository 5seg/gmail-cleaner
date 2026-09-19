import { google } from "googleapis";
import { TypeSafeClient, noul, choice, score } from "@typesafe-ai/sdk";
import fs from "node:fs/promises";
import path from "node:path";

const CREDENTIALS_PATH = path.join(import.meta.dir, "credential.json");
const TOKEN_PATH = path.join(import.meta.dir, "token.json");
const DECISIONS_PATH = path.join(import.meta.dir, "decisions.json");

export type Decision = "keep" | "delete";

/** Manual keep/delete marks, persisted across runs and keyed by Gmail message id. */
export async function loadDecisions(): Promise<Record<string, Decision>> {
  try {
    return JSON.parse(await fs.readFile(DECISIONS_PATH, "utf-8"));
  } catch {
    return {};
  }
}

export async function saveDecisions(decisions: Record<string, Decision>): Promise<void> {
  await fs.writeFile(DECISIONS_PATH, JSON.stringify(decisions, null, 2), "utf-8");
}

// Age thresholds (days) per time_sensitivity category
export const AGE_THRESHOLDS: Record<string, number | null> = {
  none: 0,        // Marketing/newsletter: unnecessary from day 0
  ephemeral: 7,   // Security/login notices: unnecessary after 7 days
  short_term: 30, // Deadline/event reminders: unnecessary after 30 days
  long_term: null, // Receipts/contracts: never auto-delete
};

export interface EmailItem {
  id: string;
  from: string;
  subject: string;
  date: string;
  ageDays: number;
  snippet: string;
}

export interface Verdict {
  isUnnecessary: boolean;
  reason: string;
  /** Model's "no longer needed" probability, 0-100 (display only). */
  deletionScore: number;
  massSent: number;
  requiresAction: number;
  referenceValue: number;
  timeSensitivity: string;
  timeSensitivityConf: number;
}

export interface JudgedEmail extends EmailItem {
  verdict?: Verdict;
}

export type Gmail = Awaited<ReturnType<typeof getGmailClient>>;
export type Jev = ReturnType<typeof getJevClient>;

export async function getGmailClient() {
  const creds = JSON.parse(await fs.readFile(CREDENTIALS_PATH, "utf-8"));
  const installed = creds.installed || creds.web;
  const tokens = JSON.parse(await fs.readFile(TOKEN_PATH, "utf-8"));

  const oauth2Client = new google.auth.OAuth2(
    installed.client_id,
    installed.client_secret,
    installed.redirect_uris?.[0] || "http://localhost"
  );
  oauth2Client.setCredentials(tokens);

  oauth2Client.on("tokens", async (newTokens) => {
    const updated = { ...tokens, ...newTokens };
    await fs.writeFile(TOKEN_PATH, JSON.stringify(updated, null, 2), "utf-8");
  });

  return google.gmail({ version: "v1", auth: oauth2Client });
}

export function getJevClient() {
  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!apiKey) throw new Error("TYPESAFE_API_KEY is missing in .env");
  return new TypeSafeClient({ apiKey });
}

/**
 * Returns up to `limit` message ids, paging through the query until it has
 * collected that many *unseen* ones. Ids present in `exclude` are skipped, so a
 * refresh continues past the messages already loaded instead of stopping at the
 * first page.
 */
export async function fetchMessages(
  gmail: Gmail,
  query: string,
  limit: number,
  exclude?: Set<string>
): Promise<string[]> {
  const ids: string[] = [];
  let pageToken: string | undefined;

  while (ids.length < limit) {
    const res = await gmail.users.messages.list({
      userId: "me",
      q: query,
      maxResults: 500,
      pageToken,
    });

    const batch = res.data.messages ?? [];
    for (const m of batch) {
      if (!m.id || exclude?.has(m.id)) continue;
      ids.push(m.id);
      if (ids.length >= limit) break;
    }

    pageToken = res.data.nextPageToken ?? undefined;
    if (!pageToken || batch.length === 0) break;
  }

  return ids.slice(0, limit);
}

function calcAgeDays(dateHeader: string): number {
  if (!dateHeader) return 0;
  const sent = new Date(dateHeader);
  if (isNaN(sent.getTime())) return 0;
  return Math.floor((Date.now() - sent.getTime()) / (1000 * 60 * 60 * 24));
}

export function judgeUnnecessary(
  timeSensitivity: string,
  requiresAction: number,
  hasReferenceValue: number,
  ageDays: number
): { isUnnecessary: boolean; reason: string } {
  // Long-term items (receipts, contracts) are never auto-deleted
  const threshold = AGE_THRESHOLDS[timeSensitivity] ?? null;
  if (threshold === null) {
    return { isUnnecessary: false, reason: "長期保存価値あり（領収書・契約等）" };
  }

  // Still requires action → keep regardless
  if (requiresAction >= 0.30) {
    return { isUnnecessary: false, reason: "行動要求あり（返信・確認・支払い等）" };
  }

  // Expiry wins: once the email is older than its time_sensitivity allows, any
  // reference value it once had is stale (deadlines passed, alerts obsolete).
  if (ageDays >= threshold) {
    const categoryLabel: Record<string, string> = {
      none: "マーケティング/メルマガ",
      ephemeral: `セキュリティ/ログイン通知（${ageDays}日経過）`,
      short_term: `期限付き通知（${ageDays}日経過）`,
    };

    return {
      isUnnecessary: true,
      reason: categoryLabel[timeSensitivity] || timeSensitivity,
    };
  }

  // Still within its validity window: reference value keeps it.
  if (hasReferenceValue >= 0.30) {
    return { isUnnecessary: false, reason: "参照価値あり（後から確認の可能性）" };
  }

  return {
    isUnnecessary: false,
    reason: `保持中（${timeSensitivity === "ephemeral" ? "7" : "30"}日経過待ち、現在${ageDays}日）`,
  };
}

export function buildQuestions(ageDays: number) {
  return {
    // Q1: Is this mass-sent (not personally addressed)?
    is_mass_sent: noul(
      "Was this email sent to many recipients at once (newsletter, marketing campaign, automated notification)? Or was it personally written to the recipient?",
      {
        true: "Bulk/automated send: newsletter, marketing, system notification, alert email",
        false: "Personal message: written directly to the recipient by a human",
      }
    ),
    // Q2: Does the recipient CURRENTLY still need to take action?
    // Critical: if the email is old, any mentioned deadlines are already past and expired.
    // Do NOT answer true just because the email once requested action — only answer true
    // if the required action is still valid and pending TODAY given the email's age.
    requires_action: noul(
      `This email was received ${ageDays} days ago. Given that ${ageDays} days have passed since receipt, does the recipient STILL need to take a concrete action TODAY (e.g., reply, pay, confirm, attend)? Any deadline or time-limited request mentioned in the email that would have expired within ${ageDays} days must be treated as already past and no longer actionable. Answer YES only if the action is genuinely still pending and valid now.`,
      {
        true: "Action still pending and valid today despite the email's age",
        false: "No action needed: either informational, or any deadline/request has already expired given the elapsed time",
      }
    ),
    // Q3: Does it have lasting reference value AS OF TODAY?
    // Critical: judge the value the email holds now, not when it arrived. An old
    // security alert or a notice with a passed deadline has no value left.
    has_reference_value: noul(
      `This email was received ${ageDays} days ago. As of today, does it still hold information the recipient would realistically need to look up again — for example a receipt, invoice, warranty, contract, booking confirmation, or account record that stays valid? Judge the value it has today, not the value it had when it arrived. Routine notifications (login/security alerts, one-off status updates, shipping notices) and any notice whose stated deadline has already passed have no remaining reference value.`,
      {
        true: "Still worth referencing today: a durable record (receipt, invoice, contract, booking confirmation) that remains valid",
        false: "No remaining reference value today: marketing, routine alert, one-off notification, or a notice whose deadline has already passed",
      }
    ),
    // Q4: How quickly does this email's importance expire?
    time_sensitivity: choice(
      `How quickly does the value of this email expire? It was received ${ageDays} days ago. A message that merely announces a deadline, campaign, or limited-time offer is never long_term — only a durable record the recipient must retain (receipt, invoice, contract, booking confirmation) is long_term.`,
      {
        none: "No expiry: marketing, promotional offers, newsletters — unnecessary from day one",
        ephemeral: "Expires in days: login alerts, security notices, OTP, new device notifications — irrelevant after ~7 days",
        short_term: "Expires in weeks/months: event reminders, deadline notices, limited-time announcements — irrelevant after ~30 days",
        long_term: "Durable record: receipts, invoices, booking confirmations, contracts, legal notices — keep indefinitely",
      }
    ),
    // Q5: Display-only probability used for the "%" badge in the TUI.
    deletion_score: score(
      `How likely is it that this email is no longer needed and can safely be deleted? It was received ${ageDays} days ago.`,
      [
        "0 = definitely still needed, keep it",
        "1 = definitely safe to delete",
      ]
    ),
  };
}

export async function mapConcurrent<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    async () => {
      while (true) {
        const index = next++;
        if (index >= items.length) return;
        results[index] = await fn(items[index]!, index);
      }
    }
  );

  await Promise.all(workers);
  return results;
}

async function fetchEmail(gmail: Gmail, id: string): Promise<EmailItem> {
  const detail = await gmail.users.messages.get({
    userId: "me",
    id,
    format: "metadata",
    metadataHeaders: ["From", "Subject", "Date"],
  });

  const headers = detail.data.payload?.headers || [];
  const header = (name: string) =>
    headers.find((h) => h.name?.toLowerCase() === name)?.value ?? "";

  const date = header("date");
  return {
    id,
    from: header("from") || "(Unknown)",
    subject: header("subject") || "(No Subject)",
    date,
    ageDays: calcAgeDays(date),
    snippet: detail.data.snippet ?? "",
  };
}

export async function loadEmails(
  gmail: Gmail,
  ids: string[],
  concurrency: number,
  onItem?: (index: number, item: EmailItem) => void
): Promise<EmailItem[]> {
  return mapConcurrent(ids, concurrency, async (id, index) => {
    let item: EmailItem;
    try {
      item = await fetchEmail(gmail, id);
    } catch (e) {
      item = {
        id,
        from: "(取得失敗)",
        subject: `(取得失敗: ${(e as Error).message})`,
        date: "",
        ageDays: 0,
        snippet: "",
      };
    }
    onItem?.(index, item);
    return item;
  });
}

export async function trashMessages(
  gmail: Gmail,
  items: { id: string }[],
  concurrency: number,
  onResult?: (index: number, item: { id: string }, ok: boolean) => void
): Promise<number> {
  let ok = 0;
  await mapConcurrent(items, concurrency, async (item, index) => {
    let success = false;
    try {
      await gmail.users.messages.trash({ userId: "me", id: item.id });
      ok++;
      success = true;
    } catch {
      // keep the item in place on failure so it can be retried
    }
    onResult?.(index, item, success);
  });
  return ok;
}

export async function judgeEmail(jev: Jev, item: EmailItem): Promise<Verdict> {
  const state = [
    `From: ${item.from}`,
    `Subject: ${item.subject}`,
    `Age: ${item.ageDays} days old`,
    `Snippet: ${item.snippet.slice(0, 300)}`,
  ].join("\n");

  const { answers } = await jev.systemOne({
    state,
    questions: buildQuestions(item.ageDays),
  });

  const timeSensitivity = answers.time_sensitivity.choice;
  const requiresAction = answers.requires_action.noul;
  const hasReferenceValue = answers.has_reference_value.noul;
  const { isUnnecessary, reason } = judgeUnnecessary(
    timeSensitivity,
    requiresAction,
    hasReferenceValue,
    item.ageDays
  );

  // Keep the displayed % consistent with the deterministic verdict:
  // delete decisions land in 75-100, keep decisions in 0-25.
  const rawScore = Math.round(answers.deletion_score.score * 100);
  const deletionScore = isUnnecessary ? Math.max(75, rawScore) : Math.min(25, rawScore);

  return {
    isUnnecessary,
    reason,
    deletionScore,
    massSent: answers.is_mass_sent.noul,
    requiresAction,
    referenceValue: hasReferenceValue,
    timeSensitivity,
    timeSensitivityConf: Math.round(answers.time_sensitivity.confidence * 100),
  };
}

export async function judgeAll(
  jev: Jev,
  items: EmailItem[],
  concurrency: number,
  onVerdict?: (index: number, verdict: Verdict) => void
): Promise<Verdict[]> {
  return mapConcurrent(items, concurrency, async (item, index) => {
    let verdict: Verdict;
    try {
      verdict = await judgeEmail(jev, item);
    } catch (e) {
      verdict = {
        isUnnecessary: false,
        reason: `判定エラー: ${(e as Error).message}`,
        deletionScore: 0,
        massSent: 0,
        requiresAction: 0,
        referenceValue: 0,
        timeSensitivity: "error",
        timeSensitivityConf: 0,
      };
    }
    onVerdict?.(index, verdict);
    return verdict;
  });
}
