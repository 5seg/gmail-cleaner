import { useEffect, useRef, useState } from "react";
import { Box, Text, render, useApp, useInput, useStdout } from "ink";
import {
  fetchMessages,
  getGmailClient,
  getJevClient,
  judgeAll,
  loadDecisions,
  loadEmails,
  saveDecisions,
  trashMessages,
  type Decision,
  type Gmail,
  type Jev,
  type JudgedEmail,
} from "./cleaner.ts";

const CURSOR_W = 1;
const BADGE_W = 11;
const META_W = 24;
const SEP = "│";

type Phase = "fetching" | "loading" | "ready" | "judging" | "trashing" | "done";

interface RowItem extends JudgedEmail {
  manual?: "delete" | "keep";
}

function progressBar(done: number, total: number, width = 20): string {
  const filled = total > 0 ? Math.round((done / total) * width) : 0;
  return `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
}

function senderName(from: string): string {
  const name = from.split("<")[0]?.trim().replace(/^"|"$/g, "");
  return name || from;
}

// Effective action: a manual mark always wins over the Jev verdict.
function isDeleteMarked(item: RowItem): boolean {
  if (item.manual) return item.manual === "delete";
  return item.verdict?.isUnnecessary === true;
}

function badge(item: RowItem): { label: string; color: string } {
  const del = isDeleteMarked(item);
  const icon = del ? "🗑️" : "✅";

  if (item.manual) return { label: `${icon}* (手動)`, color: "magenta" };
  if (!item.verdict) return { label: "—", color: "gray" };
  if (item.verdict.timeSensitivity === "error") return { label: "⚠ error", color: "yellow" };

  return {
    label: `${icon} (${item.verdict.deletionScore}%)`,
    color: del ? "red" : "green",
  };
}

function Row({ item, selected, titleW }: { item: RowItem; selected: boolean; titleW: number }) {
  const b = badge(item);
  const meta = item.from ? `${senderName(item.from)} / ${item.ageDays}日` : "";
  return (
    <Box>
      <Box width={CURSOR_W}>
        <Text color="cyan">{selected ? "▶" : " "}</Text>
      </Box>
      <Text dimColor>{SEP}</Text>
      <Box width={BADGE_W}>
        <Text color={b.color} bold={selected}>
          {b.label}
        </Text>
      </Box>
      <Text dimColor>{SEP}</Text>
      <Box width={titleW}>
        <Text wrap="truncate-end" bold={selected}>
          {item.subject}
        </Text>
      </Box>
      <Text dimColor>{SEP}</Text>
      <Box width={META_W}>
        <Text wrap="truncate-end" dimColor>
          {meta}
        </Text>
      </Box>
    </Box>
  );
}

export function App({ query, limit }: { query: string; limit: number }) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const columns = stdout?.columns ?? 100;
  const rows = stdout?.rows ?? 30;
  const viewport = Math.max(5, rows - 7);

  const [phase, setPhase] = useState<Phase>("fetching");
  const [emails, setEmails] = useState<RowItem[]>([]);
  const [view, setView] = useState({ cursor: 0, offset: 0 });
  const [status, setStatus] = useState("");
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [confirm, setConfirm] = useState(false);

  const gmailRef = useRef<Gmail | null>(null);
  const jevRef = useRef<Jev | null>(null);
  const decisionsRef = useRef<Record<string, Decision>>({});

  useEffect(() => {
    void (async () => {
      try {
        const gmail = await getGmailClient();
        gmailRef.current = gmail;
        decisionsRef.current = await loadDecisions();
        const ids = await fetchMessages(gmail, query, limit);

        if (ids.length === 0) {
          setStatus("該当するメールがありません");
          setPhase("done");
          return;
        }

        setEmails(
          ids.map((id) => ({
            id,
            from: "",
            subject: "読み込み中…",
            date: "",
            ageDays: 0,
            snippet: "",
            manual: decisionsRef.current[id],
          }))
        );
        setProgress({ done: 0, total: ids.length });
        setPhase("loading");

        await loadEmails(gmail, ids, 8, (i, item) => {
          setEmails((prev) => {
            const next = prev.slice();
            next[i] = { ...item, manual: decisionsRef.current[item.id] };
            return next;
          });
          setProgress((p) => ({ ...p, done: p.done + 1 }));
        });

        setPhase("ready");
      } catch (e) {
        setStatus(`エラー: ${(e as Error).message}`);
        setPhase("done");
      }
    })();
  }, []);

  const startJudge = () => {
    if (phase !== "ready" && phase !== "done") return;

    // Only judge what has not been judged yet, so refreshed-in mail can be
    // processed without re-running (and overwriting) existing verdicts.
    const targets = emails
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => !item.verdict);

    if (targets.length === 0) {
      setStatus("未判定のメールはありません");
      return;
    }

    const jev = jevRef.current ?? (jevRef.current = getJevClient());
    const indices = targets.map((t) => t.index);
    setPhase("judging");
    setStatus("");
    setProgress({ done: 0, total: targets.length });

    void judgeAll(
      jev,
      targets.map((t) => t.item),
      5,
      (i, verdict) => {
        const index = indices[i];
        if (index === undefined) return;
        setEmails((prev) => {
          const next = prev.slice();
          next[index] = { ...next[index]!, verdict };
          return next;
        });
        setProgress((p) => ({ ...p, done: p.done + 1 }));
      }
    ).then(() => setPhase("done"));
  };

  const refresh = async () => {
    if (phase !== "ready" && phase !== "done") return;
    const gmail = gmailRef.current;
    if (!gmail) return;

    const hadVerdicts = emails.some((e) => e.verdict);
    const restore = () => setPhase(hadVerdicts ? "done" : "ready");

    setStatus("");
    setPhase("loading");
    setProgress({ done: 0, total: 0 });

    try {
      const known = new Set(emails.map((e) => e.id));
      const newIds = await fetchMessages(gmail, query, limit, known);

      if (newIds.length === 0) {
        restore();
        setStatus("新しいメールはありません");
        return;
      }

      setEmails((prev) => [
        ...newIds.map((id) => ({
          id,
          from: "",
          subject: "読み込み中…",
          date: "",
          ageDays: 0,
          snippet: "",
          manual: decisionsRef.current[id],
        })),
        ...prev,
      ]);
      setView({ cursor: 0, offset: 0 });
      setProgress({ done: 0, total: newIds.length });

      await loadEmails(gmail, newIds, 8, (i, item) => {
        setEmails((prev) => {
          const next = prev.slice();
          next[i] = { ...item, manual: decisionsRef.current[item.id] };
          return next;
        });
        setProgress((p) => ({ ...p, done: p.done + 1 }));
      });

      restore();
      setStatus(
        `${newIds.length}件を追加取得しました（表示中 ${emails.length + newIds.length}件）`
      );
    } catch (e) {
      restore();
      setStatus(`取得エラー: ${(e as Error).message}`);
    }
  };

  const toggleMark = () => {
    const current = emails[view.cursor];
    if (!current) return;
    const manual: Decision = isDeleteMarked(current) ? "keep" : "delete";
    decisionsRef.current[current.id] = manual;
    void saveDecisions(decisionsRef.current);
    setEmails((prev) => {
      const next = prev.slice();
      next[view.cursor] = { ...current, manual };
      return next;
    });
  };

  const runTrash = async () => {
    setConfirm(false);
    const gmail = gmailRef.current;
    if (!gmail) return;

    const targets = emails.filter(isDeleteMarked);
    if (targets.length === 0) {
      setStatus("削除対象はありません");
      return;
    }

    setStatus("");
    setPhase("trashing");
    setProgress({ done: 0, total: targets.length });

    const ok = await trashMessages(gmail, targets, 5, (_index, item, success) => {
      if (success) setEmails((prev) => prev.filter((e) => e.id !== item.id));
      setProgress((p) => ({ ...p, done: p.done + 1 }));
    });

    const remaining = emails.length - ok;
    setView((v) => ({
      cursor: Math.min(v.cursor, Math.max(0, remaining - 1)),
      offset: Math.max(0, Math.min(v.offset, Math.max(0, remaining - viewport))),
    }));

    setPhase("done");
    setStatus(
      ok < targets.length
        ? `${ok}件をGmailの「ゴミ箱」に移動しました（${targets.length - ok}件失敗）`
        : `${ok}件をGmailの「ゴミ箱」に移動しました`
    );
  };

  const move = (delta: number) => {
    setView((v) => {
      const max = Math.max(0, emails.length - 1);
      const cursor = Math.max(0, Math.min(max, v.cursor + delta));
      let offset = v.offset;
      if (cursor < offset) offset = cursor;
      if (cursor >= offset + viewport) offset = cursor - viewport + 1;
      offset = Math.max(0, Math.min(offset, Math.max(0, emails.length - viewport)));
      return { cursor, offset };
    });
  };

  useInput((input, key) => {
    if ((key.ctrl && input === "c") || input === "q") {
      exit();
      return;
    }

    if (confirm) {
      if (input.toLowerCase() === "y") void runTrash();
      else {
        setConfirm(false);
        setStatus("削除をキャンセルしました");
      }
      return;
    }

    if (phase !== "ready" && phase !== "done") return;

    if (key.upArrow || input === "k") move(-1);
    else if (key.downArrow || input === "j") move(1);
    else if (key.pageUp) move(-viewport);
    else if (key.pageDown) move(viewport);
    else if (input === "g") setView({ cursor: 0, offset: 0 });
    else if (input === "G")
      setView({
        cursor: Math.max(0, emails.length - 1),
        offset: Math.max(0, emails.length - viewport),
      });
    else if (input === "x" || input === " ") toggleMark();
    else if (input === "r") void refresh();
    else if (key.return || input === "a") startJudge();
    else if (input === "d") {
      const n = emails.filter(isDeleteMarked).length;
      if (n > 0) {
        setConfirm(true);
        setStatus(`🗑️ ${n}件をGmailの「ゴミ箱」に移動しますか？ (y/N)`);
      } else {
        setStatus("削除対象はありません");
      }
    }
  });

  const deleteCount = emails.filter(isDeleteMarked).length;
  const manualCount = emails.filter((e) => e.manual).length;
  const titleW = Math.max(20, columns - (CURSOR_W + BADGE_W + META_W + 6));

  const phaseLabel = (() => {
    switch (phase) {
      case "fetching":
        return "メール一覧を取得中…";
      case "loading":
        return `メール読込中   ${progressBar(progress.done, progress.total)} ${progress.done}/${progress.total}`;
      case "judging":
        return `Jev 判定中     ${progressBar(progress.done, progress.total)} ${progress.done}/${progress.total}`;
      case "trashing":
        return `ゴミ箱へ移動中 ${progressBar(progress.done, progress.total)} ${progress.done}/${progress.total}`;
      case "ready":
        return `${emails.length}件 取得済み — Enter で全件判定 / x で手動選択`;
      case "done": {
        const manualNote = manualCount > 0 ? `（手動 ${manualCount}件）` : "";
        return `削除予定 ${deleteCount}件 / 保持 ${emails.length - deleteCount}件${manualNote}`;
      }
    }
  })();

  const hint = confirm
    ? "y: 実行 / その他のキー: キャンセル"
    : phase === "ready"
      ? "↑↓ / k j: 移動  x: 残す/消す切替  r: 再取得  Enter: 判定  q: 終了"
      : phase === "done"
        ? "↑↓ / k j: 移動  x: 残す/消す切替  r: 再取得  Enter: 未判定を判定  d: 削除実行  q: 終了"
        : "処理中… (q: 終了)";

  const visible = emails.slice(view.offset, view.offset + viewport);

  return (
    <Box flexDirection="column">
      <Box>
        <Text bold color="cyan">
          📧 Gmail Cleaner
        </Text>
        <Text dimColor> {query}</Text>
      </Box>
      <Box>
        <Text dimColor>{status || phaseLabel}</Text>
      </Box>

      <Box>
        <Box width={CURSOR_W}>
          <Text> </Text>
        </Box>
        <Text dimColor>{SEP}</Text>
        <Box width={BADGE_W}>
          <Text bold dimColor>
            判定
          </Text>
        </Box>
        <Text dimColor>{SEP}</Text>
        <Box width={titleW}>
          <Text bold dimColor>
            件名
          </Text>
        </Box>
        <Text dimColor>{SEP}</Text>
        <Box width={META_W}>
          <Text bold dimColor>
            送信者 / 経過
          </Text>
        </Box>
      </Box>

      {visible.map((item, idx) => (
        <Row
          key={item.id}
          item={item}
          selected={view.offset + idx === view.cursor}
          titleW={titleW}
        />
      ))}

      <Box marginTop={1}>
        <Text dimColor>{hint}</Text>
      </Box>
    </Box>
  );
}

export function startTui(opts: { query: string; limit: number }) {
  render(<App query={opts.query} limit={opts.limit} />);
}
