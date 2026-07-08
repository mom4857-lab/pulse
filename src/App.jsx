import { useState, useEffect, useRef } from "react";
import { X, Link2, Plus, Copy, Download, ChevronLeft, ChevronRight, Activity, RefreshCw } from "lucide-react";
import { storage } from "./storage.js";

const STORAGE_KEY = "news-journal-entries";

// ---------- date helpers ----------
function startOfWeek(d) {
  const date = new Date(d);
  const day = date.getDay();
  const diff = (day === 0 ? -6 : 1) - day;
  date.setDate(date.getDate() + diff);
  date.setHours(0, 0, 0, 0);
  return date;
}
function endOfWeek(d) {
  const s = startOfWeek(d);
  const e = new Date(s);
  e.setDate(e.getDate() + 6);
  e.setHours(23, 59, 59, 999);
  return e;
}
function shiftRef(type, date, dir) {
  const d = new Date(date);
  if (type === "year") d.setFullYear(d.getFullYear() + dir);
  else if (type === "month") d.setMonth(d.getMonth() + dir);
  else d.setDate(d.getDate() + dir * 7);
  return d;
}
function isInPeriod(entryDateStr, type, refDate) {
  const ed = new Date(entryDateStr + "T00:00:00");
  if (type === "year") return ed.getFullYear() === refDate.getFullYear();
  if (type === "month")
    return (
      ed.getFullYear() === refDate.getFullYear() &&
      ed.getMonth() === refDate.getMonth()
    );
  const s = startOfWeek(refDate);
  const e = endOfWeek(refDate);
  return ed >= s && ed <= e;
}
function periodLabel(type, refDate) {
  if (type === "year") return `${refDate.getFullYear()}년`;
  if (type === "month") return `${refDate.getFullYear()}년 ${refDate.getMonth() + 1}월`;
  const s = startOfWeek(refDate);
  const e = endOfWeek(refDate);
  return `${s.getFullYear()}년 ${s.getMonth() + 1}월 ${s.getDate()}일 ~ ${
    e.getMonth() !== s.getMonth() ? e.getMonth() + 1 + "월 " : ""
  }${e.getDate()}일`;
}
function todayStr() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// ---------- tag helpers ----------
function getTagCounts(list, category) {
  const counts = {};
  list.forEach((e) => {
    const tags = category === "industry" ? e.industryTags : e.stockTags;
    (tags || []).forEach((t) => {
      counts[t] = (counts[t] || 0) + 1;
    });
  });
  return Object.entries(counts).sort((a, b) => b[1] - a[1]);
}
function scaleSize(count, max) {
  const min = 14,
    maxSize = 40;
  if (max <= 1) return 22;
  return Math.round(min + (count / max) * (maxSize - min));
}
function scaleOpacity(count, max) {
  const minO = 0.42,
    maxO = 1;
  if (max <= 1) return 1;
  return (minO + (count / max) * (maxO - minO)).toFixed(2);
}
function hashRotate(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
  return (Math.abs(h) % 9) - 4;
}
function decodeEntities(str) {
  const el = document.createElement("textarea");
  el.innerHTML = str;
  return el.value;
}
function parseSummaryLines(summary) {
  return (summary || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^([*\-•]|\d+[).])\s*/, ""));
}

export default function NewsJournal() {
  const [entries, setEntries] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [periodType, setPeriodType] = useState("week");
  const [refDate, setRefDate] = useState(new Date());
  const [category, setCategory] = useState("industry");
  const [selectedTag, setSelectedTag] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [toast, setToast] = useState(null);
  const [manualCopyText, setManualCopyText] = useState(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [summarizing, setSummarizing] = useState({});
  const listRef = useRef(null);

  // form state
  const [fUrl, setFUrl] = useState("");
  const [fTitle, setFTitle] = useState("");
  const [fDate, setFDate] = useState(todayStr());
  const [fIndustryInput, setFIndustryInput] = useState("");
  const [fStockInput, setFStockInput] = useState("");
  const [fIndustryTags, setFIndustryTags] = useState([]);
  const [fStockTags, setFStockTags] = useState([]);
  const [fSummary, setFSummary] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const res = await storage.get(STORAGE_KEY);
        setEntries(res ? JSON.parse(res.value) : []);
      } catch (e) {
        setEntries([]);
      } finally {
        setLoaded(true);
      }
    })();
  }, []);

  function showToast(msg, duration = 2600) {
    setToast(msg);
    setTimeout(() => setToast(null), duration);
  }

  async function persist(newEntries) {
    setEntries(newEntries);
    try {
      const ok = await storage.set(STORAGE_KEY, JSON.stringify(newEntries));
      if (!ok) showToast("저장에 실패했어요. 다시 시도해주세요.");
    } catch (e) {
      showToast("저장 중 오류가 발생했어요.");
    }
  }

  // Safely merges a patch into an entry using the latest state at write time,
  // rather than whatever `entries` looked like when the async call started.
  // This avoids clobbering newer saves that happened while an await (like the
  // AI summary fetch) was in flight.
  function patchEntry(id, patch) {
    setEntries((prev) => {
      const updated = prev.map((e) =>
        e.id === id ? { ...e, ...(typeof patch === "function" ? patch(e) : patch) } : e
      );
      storage
        .set(STORAGE_KEY, JSON.stringify(updated))
        .then((ok) => {
          if (!ok) showToast("저장에 실패했어요. 다시 시도해주세요.");
        })
        .catch(() => showToast("저장 중 오류가 발생했어요."));
      return updated;
    });
  }

  function addSuggestedKeyword(entryId, keyword, category) {
    const field = category === "industry" ? "industryTags" : "stockTags";
    const suggestField = category === "industry" ? "aiIndustryKeywords" : "aiStockKeywords";
    patchEntry(entryId, (e) => {
      const current = e[field] || [];
      const alreadyThere = current.some((t) => t.toLowerCase() === keyword.toLowerCase());
      return {
        [field]: alreadyThere ? current : [...current, keyword],
        [suggestField]: (e[suggestField] || []).filter((k) => k !== keyword),
      };
    });
    showToast(`#${keyword} 키워드를 추가했어요.`);
  }

  function resetForm() {
    setEditingId(null);
    setFUrl("");
    setFTitle("");
    setFDate(todayStr());
    setFIndustryInput("");
    setFStockInput("");
    setFIndustryTags([]);
    setFStockTags([]);
    setFSummary("");
  }

  function openEdit(entry) {
    setEditingId(entry.id);
    setFUrl(entry.url || "");
    setFTitle(entry.title || "");
    setFDate(entry.date || todayStr());
    setFIndustryInput("");
    setFStockInput("");
    setFIndustryTags(entry.industryTags || []);
    setFStockTags(entry.stockTags || []);
    setFSummary(entry.summary || "");
    setShowForm(true);
  }

  function addChip(input, setInput, tags, setTags) {
    const clean = input.trim().replace(/^#/, "");
    if (!clean) return;
    if (tags.some((t) => t.toLowerCase() === clean.toLowerCase())) {
      setInput("");
      return;
    }
    setTags([...tags, clean]);
    setInput("");
  }

  async function requestOneLiner(entry) {
    setSummarizing((s) => ({ ...s, [entry.id]: true }));
    try {
      const bulletText = parseSummaryLines(entry.summary).join(" / ");
      const res = await fetch("/api/summarize", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: entry.url || "", text: bulletText }),
      });
      let data = null;
      try {
        data = await res.json();
      } catch (parseErr) {
        throw new Error(`서버 응답을 읽을 수 없어요 (status ${res.status})`);
      }
      if (!res.ok) {
        const reason = data && (data.error || data.detail) ? `${data.error || ""} ${data.detail || ""}`.trim() : `status ${res.status}`;
        throw new Error(reason);
      }
      if (data.summary) {
        patchEntry(entry.id, {
          oneLiner: data.summary,
          aiIndustryKeywords: Array.isArray(data.industryKeywords) ? data.industryKeywords : [],
          aiStockKeywords: Array.isArray(data.stockKeywords) ? data.stockKeywords : [],
        });
      } else {
        throw new Error("요약 결과가 비어 있어요.");
      }
    } catch (e) {
      showToast(`AI 요약 실패: ${String(e.message || e).slice(0, 160)}`, 9000);
    } finally {
      setSummarizing((s) => {
        const next = { ...s };
        delete next[entry.id];
        return next;
      });
    }
  }

  function handleSave() {
    if (!fTitle.trim() && !fUrl.trim()) {
      showToast("제목이나 뉴스 링크 중 하나는 입력해주세요.");
      return;
    }
    if (!fSummary.trim()) {
      showToast("요약을 작성해주세요.");
      return;
    }
    if (editingId) {
      const original = entries.find((e) => e.id === editingId);
      const summaryChanged = original && original.summary !== fSummary.trim();
      const updatedEntry = {
        ...original,
        date: fDate,
        url: fUrl.trim(),
        title: fTitle.trim() || "(제목 없음)",
        industryTags: fIndustryTags,
        stockTags: fStockTags,
        summary: fSummary.trim(),
        oneLiner: summaryChanged ? undefined : original?.oneLiner,
      };
      const updated = entries.map((e) => (e.id === editingId ? updatedEntry : e));
      persist(updated);
      resetForm();
      setShowForm(false);
      showToast("기록을 수정했어요.");
      if (summaryChanged) requestOneLiner(updatedEntry);
      return;
    }
    const entry = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      date: fDate,
      url: fUrl.trim(),
      title: fTitle.trim() || "(제목 없음)",
      industryTags: fIndustryTags,
      stockTags: fStockTags,
      summary: fSummary.trim(),
      createdAt: Date.now(),
    };
    persist([...entries, entry]);
    resetForm();
    setShowForm(false);
    showToast("기록을 저장했어요.");
    requestOneLiner(entry);
  }

  function handleDelete(id) {
    persist(entries.filter((e) => e.id !== id));
    setConfirmDeleteId(null);
    showToast("삭제했어요.");
  }

  const periodEntries = entries.filter((e) => isInPeriod(e.date, periodType, refDate));
  const displayedEntries = (selectedTag
    ? periodEntries.filter((e) =>
        (category === "industry" ? e.industryTags : e.stockTags || []).includes(selectedTag)
      )
    : periodEntries
  )
    .slice()
    .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt);

  const tagCounts = getTagCounts(periodEntries, category);
  const maxCount = tagCounts.length ? tagCounts[0][1] : 1;

  function buildBlogText() {
    const industryCounts = getTagCounts(periodEntries, "industry");
    const stockCounts = getTagCounts(periodEntries, "stock");
    let text = `📅 ${periodLabel(periodType, refDate)} 뉴스 노트\n\n`;
    periodEntries
      .slice()
      .sort((a, b) => a.date.localeCompare(b.date))
      .forEach((e) => {
        text += `[${e.date}] ${e.title}\n`;
        if (e.oneLiner) {
          e.oneLiner
            .split("\n")
            .map((l) => l.trim())
            .filter(Boolean)
            .forEach((l) => {
              text += `▸ ${l}\n`;
            });
        }
        text += `${e.summary}\n`;
        if (e.url) text += `🔗 ${e.url}\n`;
        const allTags = [...(e.industryTags || []), ...(e.stockTags || [])];
        if (allTags.length) text += allTags.map((t) => "#" + t).join(" ") + "\n";
        text += "\n";
      });
    text += `---\n📊 이번 기간 주요 키워드\n`;
    text += `산업군: ${industryCounts.map(([t, c]) => `${t}(${c})`).join(", ") || "없음"}\n`;
    text += `종목·기술: ${stockCounts.map(([t, c]) => `${t}(${c})`).join(", ") || "없음"}\n`;
    return text;
  }

  async function handleCopyBlog() {
    const text = buildBlogText();
    try {
      await navigator.clipboard.writeText(text);
      showToast("복사했어요. 네이버 블로그에 붙여넣으세요.");
    } catch (e) {
      setManualCopyText(text);
    }
  }

  function handleDownloadBlog() {
    const text = buildBlogText();
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `Pulse_${periodLabel(periodType, refDate).replace(/\s/g, "")}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function scrollToList() {
    listRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return (
    <div className="nj-root">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap');

        .nj-root {
          --bg: #0a0d13;
          --surface: #12161f;
          --surface-raised: #1a1f2b;
          --line: rgba(255,255,255,0.09);
          --text: #e9ecf3;
          --text-soft: #838da0;
          --teal: #2dd4bf;
          --violet: #a78bfa;
          --rose: #fb7185;
          font-family: 'Inter', sans-serif;
          color: var(--text);
          background: var(--bg);
          min-height: 100%;
          padding: 0;
          border-radius: 14px;
          overflow: hidden;
        }
        .nj-inner { padding: 28px 24px 40px; max-width: 1180px; margin: 0 auto; }
        .nj-header {
          display: flex; align-items: center; justify-content: space-between;
          padding-bottom: 18px; margin-bottom: 22px;
          border-bottom: 1px solid var(--line);
          animation: nj-fade-in .5s ease;
        }
        .nj-title { display: flex; align-items: center; gap: 12px; }
        .nj-pulse-icon { color: var(--teal); filter: drop-shadow(0 0 6px rgba(45,212,191,0.55)); animation: nj-beat 2.4s ease-in-out infinite; }
        .nj-title h1 {
          font-family: 'Space Grotesk', sans-serif; font-weight: 700;
          font-size: 26px; margin: 0; letter-spacing: -0.03em;
          background: linear-gradient(90deg, #f2f4fa 0%, var(--teal) 130%);
          -webkit-background-clip: text; background-clip: text; color: transparent;
        }
        .nj-title .nj-sub { font-size: 12px; color: var(--text-soft); margin-top: 3px; font-family: 'JetBrains Mono', monospace; }
        .nj-newbtn {
          display: flex; align-items: center; gap: 6px;
          background: linear-gradient(135deg, var(--teal), var(--violet)); color: #0a0d13; border: none;
          padding: 10px 18px; border-radius: 10px; font-size: 14px; font-weight: 700;
          cursor: pointer; transition: transform .15s ease, box-shadow .15s ease;
          font-family: 'Inter', sans-serif;
        }
        .nj-newbtn:hover { transform: translateY(-1px); box-shadow: 0 6px 20px rgba(45,212,191,0.35); }

        .nj-controls {
          display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between;
          gap: 12px; margin-bottom: 18px;
        }
        .nj-seg { display: flex; background: var(--surface); border: 1px solid var(--line); border-radius: 10px; overflow: hidden; }
        .nj-seg button {
          border: none; background: transparent; padding: 7px 14px; font-size: 13px;
          cursor: pointer; color: var(--text-soft); font-family: 'Inter', sans-serif;
          transition: background .15s ease, color .15s ease;
        }
        .nj-seg button.active { background: linear-gradient(135deg, var(--teal), var(--violet)); color: #0a0d13; font-weight: 700; }
        .nj-seg button:hover:not(.active) { background: var(--surface-raised); color: var(--text); }

        .nj-nav { display: flex; align-items: center; gap: 10px; font-family: 'JetBrains Mono', monospace; font-size: 13px; }
        .nj-nav button { border: 1px solid var(--line); background: var(--surface); border-radius: 7px; width: 28px; height: 28px; cursor: pointer; display:flex; align-items:center; justify-content:center; color: var(--teal); }
        .nj-nav button:hover { background: var(--surface-raised); }
        .nj-nav .nj-label { min-width: 170px; text-align: center; font-weight: 600; color: var(--text); font-family: 'Inter', sans-serif; }

        .nj-cloud-panel {
          background: radial-gradient(120% 140% at 50% 0%, rgba(45,212,191,0.07), transparent 60%), var(--surface);
          border: 1px solid var(--line); border-radius: 14px;
          padding: 32px 20px; min-height: 190px; display: flex; align-items: center; justify-content: center;
          flex-wrap: wrap; gap: 10px 14px; margin-bottom: 14px; position: relative; overflow: hidden;
        }
        .nj-cloud-empty { color: var(--text-soft); font-size: 14px; position: relative; z-index: 1; }
        .nj-stamp {
          display: inline-block; font-family: 'Inter', sans-serif; font-weight: 600;
          cursor: pointer; border: 1.5px solid currentColor; border-radius: 999px; padding: 4px 14px;
          background: rgba(255,255,255,0.02); user-select: none; transition: transform .15s ease, box-shadow .15s ease;
          position: relative; z-index: 1;
        }
        .nj-stamp:hover { transform: scale(1.07); }
        .nj-stamp.selected { background: currentColor; }
        .nj-stamp.selected span { color: var(--bg); }
        .nj-stamp-count { font-size: 0.72em; opacity: 0.7; margin-left: 5px; font-family: 'JetBrains Mono', monospace; font-weight: 500; }

        .nj-cat-industry .nj-stamp { color: var(--teal); box-shadow: 0 0 12px rgba(45,212,191,0.18); }
        .nj-cat-stock .nj-stamp { color: var(--violet); box-shadow: 0 0 12px rgba(167,139,250,0.18); }

        .nj-export-row { display: flex; gap: 8px; margin-bottom: 22px; }
        .nj-export-row button {
          display: flex; align-items: center; gap: 6px; font-size: 13px;
          border: 1px solid var(--line); background: var(--surface); color: var(--text);
          padding: 8px 12px; border-radius: 8px; cursor: pointer; font-family: 'Inter', sans-serif;
          transition: border-color .15s ease;
        }
        .nj-export-row button:hover { border-color: var(--teal); }

        .nj-list-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
        .nj-list-header h2 { font-size: 15px; margin: 0; font-family: 'Space Grotesk', sans-serif; font-weight: 600; }
        .nj-clear-tag { font-size: 12px; color: var(--rose); background: none; border: none; cursor: pointer; text-decoration: underline; }

        .nj-entry {
          background: var(--surface); border: 1px solid var(--line); border-radius: 12px;
          padding: 14px 16px; margin-bottom: 10px; transition: border-color .15s ease;
        }
        .nj-entry:hover { border-color: rgba(45,212,191,0.35); }
        .nj-entry-top { display: flex; flex-direction: column; gap: 3px; }
        .nj-entry-date { font-family: 'JetBrains Mono', monospace; font-size: 12px; color: var(--text-soft); }
        .nj-entry-title { font-weight: 600; font-size: 14.5px; color: var(--teal); text-decoration: none; }
        .nj-entry-title:hover { text-decoration: underline; }
        .nj-entry-summary { margin: 8px 0; }
        .nj-summary-line { display: flex; align-items: flex-start; gap: 9px; font-size: 13.5px; line-height: 1.6; color: var(--text); padding: 2px 0; }
        .nj-summary-marker { flex: none; width: 7px; height: 7px; margin-top: 6.5px; border-radius: 2px; background: linear-gradient(135deg, var(--teal), var(--violet)); }
        .nj-ai-summary { margin-top: 10px; padding-top: 10px; border-top: 1px dashed var(--line); }
        .nj-ai-summary-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 5px; }
        .nj-ai-summary-label { font-size: 11px; font-family: 'JetBrains Mono', monospace; color: var(--violet); font-weight: 700; letter-spacing: 0.03em; }
        .nj-ai-refresh-btn { border: none; background: none; color: var(--text-soft); cursor: pointer; display: flex; align-items: center; padding: 3px; border-radius: 5px; transition: color .15s ease, background .15s ease; }
        .nj-ai-refresh-btn:hover { color: var(--violet); background: rgba(167,139,250,0.12); }
        .nj-summary-line.ai { font-size: 13px; }
        .nj-summary-marker.ai { background: var(--violet); }
        .nj-oneline-btn { border: none; background: none; color: var(--violet); font-size: 12px; cursor: pointer; padding: 0; font-family: 'Inter', sans-serif; }
        .nj-oneline-btn:hover { text-decoration: underline; }
        .nj-ai-kw-row { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 9px; }
        .nj-ai-kw-chip {
          display: inline-flex; align-items: center; gap: 5px; font-size: 11px; padding: 3px 5px 3px 10px;
          border-radius: 999px; font-family: 'JetBrains Mono', monospace; border: 1px dashed;
        }
        .nj-ai-kw-chip.industry { color: var(--teal); border-color: rgba(45,212,191,0.45); background: rgba(45,212,191,0.06); }
        .nj-ai-kw-chip.stock { color: var(--violet); border-color: rgba(167,139,250,0.45); background: rgba(167,139,250,0.06); }
        .nj-kw-add-btn {
          border: none; background: rgba(255,255,255,0.1); color: inherit; width: 16px; height: 16px; border-radius: 50%;
          font-size: 10px; font-weight: 700; cursor: pointer; display: flex; align-items: center; justify-content: center;
          line-height: 1; padding: 0; font-family: 'Inter', sans-serif;
        }
        .nj-kw-add-btn:hover { background: currentColor; color: var(--bg); }
        .nj-entry-tags { display: flex; flex-wrap: wrap; gap: 6px; margin: 6px 0 2px; }
        .nj-chip { font-size: 11.5px; padding: 2px 9px; border-radius: 999px; font-family: 'JetBrains Mono', monospace; }
        .nj-chip.industry { background: rgba(45,212,191,0.12); color: var(--teal); }
        .nj-chip.stock { background: rgba(167,139,250,0.14); color: var(--violet); }
        .nj-entry-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 4px; }
        .nj-entry-actions button { font-size: 11.5px; border: none; background: none; color: var(--text-soft); cursor: pointer; }
        .nj-entry-actions button:hover { color: var(--rose); }
        .nj-empty-list { text-align: center; padding: 30px 10px; color: var(--text-soft); font-size: 13.5px; }

        .nj-modal-overlay {
          position: fixed; inset: 0; background: rgba(4,6,10,0.65); backdrop-filter: blur(3px); display: flex;
          align-items: center; justify-content: center; z-index: 50; padding: 16px;
        }
        .nj-modal {
          background: var(--surface); border: 1px solid var(--line); border-radius: 16px; width: 100%; max-width: 520px;
          max-height: 88vh; overflow-y: auto; padding: 22px 22px 26px; box-shadow: 0 20px 60px rgba(0,0,0,0.5);
          animation: nj-pop-in .18s ease;
        }
        .nj-modal-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
        .nj-modal-head h3 { font-family: 'Space Grotesk', sans-serif; font-size: 18px; margin: 0; font-weight: 700; }
        .nj-modal-head button { border: none; background: none; cursor: pointer; color: var(--text-soft); }
        .nj-section { margin-bottom: 18px; }
        .nj-section-label { font-size: 12.5px; font-weight: 700; color: var(--teal); margin-bottom: 8px; display: flex; align-items: center; gap: 5px; letter-spacing: 0.03em; text-transform: uppercase; }
        .nj-row { display: flex; gap: 8px; }
        .nj-input, .nj-textarea, .nj-date {
          width: 100%; border: 1px solid var(--line); background: var(--surface-raised); border-radius: 8px;
          padding: 9px 10px; font-size: 13.5px; font-family: 'Inter', sans-serif; color: var(--text);
          box-sizing: border-box;
        }
        .nj-input:focus, .nj-textarea:focus, .nj-date:focus { outline: 2px solid var(--teal); outline-offset: 1px; }
        .nj-textarea { min-height: 110px; resize: vertical; font-family: 'Inter', sans-serif; }
        .nj-field-gap { margin-top: 8px; }
        .nj-mini-label { font-size: 11.5px; color: var(--text-soft); margin-bottom: 4px; }
        .nj-chips-input { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
        .nj-chip-editable {
          display: flex; align-items: center; gap: 5px; font-size: 12px; padding: 3px 8px 3px 10px;
          border-radius: 999px; font-family: 'JetBrains Mono', monospace;
        }
        .nj-chip-editable.industry { background: rgba(45,212,191,0.14); color: var(--teal); }
        .nj-chip-editable.stock { background: rgba(167,139,250,0.16); color: var(--violet); }
        .nj-chip-editable button { border: none; background: none; cursor: pointer; color: inherit; display:flex; }
        .nj-savebtn {
          width: 100%; border: none; background: linear-gradient(135deg, var(--teal), var(--violet)); color: #0a0d13; padding: 12px;
          border-radius: 10px; font-size: 14.5px; font-weight: 700; cursor: pointer; margin-top: 6px;
          font-family: 'Inter', sans-serif; transition: box-shadow .15s ease;
        }
        .nj-savebtn:hover { box-shadow: 0 6px 22px rgba(45,212,191,0.3); }

        .nj-toast {
          position: fixed; bottom: 22px; right: 22px; background: var(--surface-raised); border: 1px solid var(--teal); color: var(--text);
          padding: 10px 16px; border-radius: 10px; font-size: 13px; z-index: 70; max-width: 380px; line-height: 1.5;
          animation: nj-fade-in .2s ease; box-shadow: 0 0 20px rgba(45,212,191,0.15);
        }
        .nj-copy-fallback {
          position: fixed; inset: 0; background: rgba(4,6,10,0.7); display:flex; align-items:center; justify-content:center; z-index: 80; padding: 20px;
        }
        .nj-copy-fallback-inner { background: var(--surface); border: 1px solid var(--line); border-radius: 12px; padding: 16px; max-width: 500px; width: 100%; }
        .nj-copy-fallback textarea { width: 100%; height: 200px; font-size: 12px; font-family: 'JetBrains Mono', monospace; padding: 10px; border-radius: 8px; border: 1px solid var(--line); background: var(--surface-raised); color: var(--text); box-sizing: border-box; }
        .nj-copy-fallback p { font-size: 12.5px; color: var(--text-soft); margin: 0 0 8px; }
        .nj-copy-fallback-close { margin-top: 10px; border: none; background: linear-gradient(135deg, var(--teal), var(--violet)); color: #0a0d13; padding: 8px 14px; border-radius: 8px; cursor: pointer; font-size: 13px; font-weight: 700; }

        @keyframes nj-fade-in { from { opacity: 0; transform: translateY(-4px);} to { opacity: 1; transform: translateY(0);} }
        @keyframes nj-pop-in { from { opacity: 0; transform: scale(0.97);} to { opacity: 1; transform: scale(1);} }
        @keyframes nj-beat { 0%, 100% { transform: scale(1); } 15% { transform: scale(1.18); } 30% { transform: scale(0.96); } 45% { transform: scale(1.1); } 60% { transform: scale(1); } }

        @media (max-width: 560px) {
          .nj-inner { padding: 18px 14px 32px; }
          .nj-controls { flex-direction: column; align-items: stretch; }
          .nj-nav { justify-content: center; }
        }
      `}</style>

      <div className="nj-inner">
        <div className="nj-header">
          <div className="nj-title">
            <Activity size={24} className="nj-pulse-icon" />
            <div>
              <h1>Pulse</h1>
              <div className="nj-sub">시장의 맥박을 짚다 · 누적 기록 {entries.length}건</div>
            </div>
          </div>
          <button
            className="nj-newbtn"
            onClick={() => {
              resetForm();
              setShowForm(true);
            }}
          >
            <Plus size={16} /> 새 기록
          </button>
        </div>

        <div className="nj-controls">
          <div className="nj-seg">
            {["year", "month", "week"].map((t) => (
              <button
                key={t}
                className={periodType === t ? "active" : ""}
                onClick={() => {
                  setPeriodType(t);
                  setSelectedTag(null);
                }}
              >
                {t === "year" ? "년" : t === "month" ? "월" : "주"}
              </button>
            ))}
          </div>
          <div className="nj-nav">
            <button onClick={() => setRefDate(shiftRef(periodType, refDate, -1))}>
              <ChevronLeft size={15} />
            </button>
            <span className="nj-label">{periodLabel(periodType, refDate)}</span>
            <button onClick={() => setRefDate(shiftRef(periodType, refDate, 1))}>
              <ChevronRight size={15} />
            </button>
          </div>
          <div className="nj-seg">
            {[
              ["industry", "산업군"],
              ["stock", "종목·기술"],
            ].map(([val, label]) => (
              <button
                key={val}
                className={category === val ? "active" : ""}
                onClick={() => {
                  setCategory(val);
                  setSelectedTag(null);
                }}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className={`nj-cloud-panel ${category === "industry" ? "nj-cat-industry" : "nj-cat-stock"}`}>
          {!loaded ? (
            <div className="nj-cloud-empty">불러오는 중...</div>
          ) : tagCounts.length === 0 ? (
            <div className="nj-cloud-empty">이 기간에는 아직 {category === "industry" ? "산업군" : "종목·기술"} 키워드가 없어요.</div>
          ) : (
            tagCounts.map(([tag, count]) => (
              <span
                key={tag}
                className={`nj-stamp${selectedTag === tag ? " selected" : ""}`}
                style={{
                  fontSize: scaleSize(count, maxCount),
                  opacity: selectedTag && selectedTag !== tag ? 0.35 : scaleOpacity(count, maxCount),
                  transform: `rotate(${hashRotate(tag)}deg)`,
                }}
                onClick={() => {
                  const next = selectedTag === tag ? null : tag;
                  setSelectedTag(next);
                  if (next) scrollToList();
                }}
                title={`${count}건`}
              >
                <span>{tag}</span>
                <span className="nj-stamp-count">{count}회</span>
              </span>
            ))
          )}
        </div>

        {periodType === "week" && (
          <div className="nj-export-row">
            <button onClick={handleCopyBlog}>
              <Copy size={14} /> 블로그용 텍스트 복사
            </button>
            <button onClick={handleDownloadBlog}>
              <Download size={14} /> 텍스트 파일 다운로드
            </button>
          </div>
        )}

        <div ref={listRef} className="nj-list-header">
          <h2>이 기간의 기록 ({displayedEntries.length}건)</h2>
          {selectedTag && (
            <button className="nj-clear-tag" onClick={() => setSelectedTag(null)}>
              #{selectedTag} 선택 해제
            </button>
          )}
        </div>

        {displayedEntries.length === 0 ? (
          <div className="nj-empty-list">
            {loaded ? "아직 기록이 없어요. 오늘 읽은 뉴스부터 남겨보세요." : "불러오는 중..."}
          </div>
        ) : (
          displayedEntries.map((e) => (
            <div className="nj-entry" key={e.id}>
              <div className="nj-entry-top">
                {e.url ? (
                  <a className="nj-entry-title" href={e.url} target="_blank" rel="noopener noreferrer">
                    {e.title} ↗
                  </a>
                ) : (
                  <span className="nj-entry-title" style={{ color: "var(--text)" }}>
                    {e.title}
                  </span>
                )}
                <span className="nj-entry-date">{e.date}</span>
              </div>
              <div className="nj-entry-tags">
                {(e.industryTags || []).map((t) => (
                  <span key={"i" + t} className="nj-chip industry">
                    #{t}
                  </span>
                ))}
                {(e.stockTags || []).map((t) => (
                  <span key={"s" + t} className="nj-chip stock">
                    #{t}
                  </span>
                ))}
              </div>
              <div className="nj-entry-summary">
                {parseSummaryLines(e.summary).map((line, i) => (
                  <div className="nj-summary-line" key={i}>
                    <span className="nj-summary-marker" />
                    <span>{line}</span>
                  </div>
                ))}
              </div>
              {e.oneLiner || summarizing[e.id] ? (
                <div className="nj-ai-summary">
                  <div className="nj-ai-summary-head">
                    <span className="nj-ai-summary-label">
                      {summarizing[e.id] ? "AI 요약 · 생성 중..." : "AI 요약"}
                    </span>
                    {!summarizing[e.id] && (
                      <button
                        className="nj-ai-refresh-btn"
                        title="AI 요약 다시 생성"
                        onClick={() => requestOneLiner(e)}
                      >
                        <RefreshCw size={12} />
                      </button>
                    )}
                  </div>
                  {e.oneLiner &&
                    e.oneLiner
                      .split("\n")
                      .map((l) => l.trim())
                      .filter(Boolean)
                      .map((line, i) => (
                        <div className="nj-summary-line ai" key={i}>
                          <span className="nj-summary-marker ai" />
                          <span>{line}</span>
                        </div>
                      ))}
                  {((e.aiIndustryKeywords && e.aiIndustryKeywords.length > 0) ||
                    (e.aiStockKeywords && e.aiStockKeywords.length > 0)) && (
                    <div className="nj-ai-kw-row">
                      {(e.aiIndustryKeywords || []).map((kw) => (
                        <span className="nj-ai-kw-chip industry" key={"aki" + kw}>
                          #{kw}
                          <button
                            className="nj-kw-add-btn"
                            title="산업군 키워드로 추가"
                            onClick={() => addSuggestedKeyword(e.id, kw, "industry")}
                          >
                            !
                          </button>
                        </span>
                      ))}
                      {(e.aiStockKeywords || []).map((kw) => (
                        <span className="nj-ai-kw-chip stock" key={"aks" + kw}>
                          #{kw}
                          <button
                            className="nj-kw-add-btn"
                            title="종목·기술 키워드로 추가"
                            onClick={() => addSuggestedKeyword(e.id, kw, "stock")}
                          >
                            !
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <div className="nj-ai-summary">
                  <button className="nj-oneline-btn" onClick={() => requestOneLiner(e)}>
                    AI 요약 생성
                  </button>
                </div>
              )}
              <div className="nj-entry-actions">
                {confirmDeleteId === e.id ? (
                  <>
                    <span style={{ fontSize: 11.5, color: "var(--text-soft)" }}>삭제할까요?</span>
                    <button onClick={() => handleDelete(e.id)}>예</button>
                    <button onClick={() => setConfirmDeleteId(null)}>아니오</button>
                  </>
                ) : (
                  <>
                    <button onClick={() => openEdit(e)}>수정</button>
                    <button onClick={() => setConfirmDeleteId(e.id)}>삭제</button>
                  </>
                )}
              </div>
            </div>
          ))
        )}
      </div>

      {showForm && (
        <div
          className="nj-modal-overlay"
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              setShowForm(false);
              resetForm();
            }
          }}
        >
          <div className="nj-modal">
            <div className="nj-modal-head">
              <h3>{editingId ? "기록 수정" : "새 뉴스 기록"}</h3>
              <button
                onClick={() => {
                  setShowForm(false);
                  resetForm();
                }}
              >
                <X size={18} />
              </button>
            </div>

            <div className="nj-section">
              <div className="nj-section-label">
                <Link2 size={13} /> 1. 뉴스 링크
              </div>
              <input
                className="nj-input"
                placeholder="https://..."
                value={fUrl}
                onChange={(ev) => setFUrl(ev.target.value)}
              />
              <div className="nj-field-gap">
                <div className="nj-mini-label">제목</div>
                <input
                  className="nj-input"
                  placeholder="뉴스 제목"
                  value={fTitle}
                  onChange={(ev) => setFTitle(ev.target.value)}
                />
              </div>
              <div className="nj-field-gap">
                <div className="nj-mini-label">날짜</div>
                <input type="date" className="nj-date" value={fDate} onChange={(ev) => setFDate(ev.target.value)} />
              </div>
            </div>

            <div className="nj-section">
              <div className="nj-section-label">2. 키워드</div>
              <div className="nj-mini-label">산업군</div>
              <div className="nj-row">
                <input
                  className="nj-input"
                  placeholder="예: 반도체, 데이터센터 (엔터로 추가)"
                  value={fIndustryInput}
                  onChange={(ev) => setFIndustryInput(ev.target.value)}
                  onKeyDown={(ev) => {
                    if (ev.key === "Enter" || ev.key === ",") {
                      ev.preventDefault();
                      addChip(fIndustryInput, setFIndustryInput, fIndustryTags, setFIndustryTags);
                    }
                  }}
                />
              </div>
              <div className="nj-chips-input">
                {fIndustryTags.map((t) => (
                  <span key={t} className="nj-chip-editable industry">
                    #{t}
                    <button onClick={() => setFIndustryTags(fIndustryTags.filter((x) => x !== t))}>
                      <X size={11} />
                    </button>
                  </span>
                ))}
              </div>

              <div className="nj-mini-label" style={{ marginTop: 12 }}>
                종목·기술
              </div>
              <div className="nj-row">
                <input
                  className="nj-input"
                  placeholder="예: SK하이닉스, HBM4 (엔터로 추가)"
                  value={fStockInput}
                  onChange={(ev) => setFStockInput(ev.target.value)}
                  onKeyDown={(ev) => {
                    if (ev.key === "Enter" || ev.key === ",") {
                      ev.preventDefault();
                      addChip(fStockInput, setFStockInput, fStockTags, setFStockTags);
                    }
                  }}
                />
              </div>
              <div className="nj-chips-input">
                {fStockTags.map((t) => (
                  <span key={t} className="nj-chip-editable stock">
                    #{t}
                    <button onClick={() => setFStockTags(fStockTags.filter((x) => x !== t))}>
                      <X size={11} />
                    </button>
                  </span>
                ))}
              </div>
            </div>

            <div className="nj-section">
              <div className="nj-section-label">3. 뉴스 요약 (직접 작성)</div>
              <div className="nj-mini-label" style={{ marginBottom: 6 }}>
                엔터로 문단을 나눠서 적어보면 나중에 읽기 편해요. 예: 1) ... ↵ 2) ...
              </div>
              <textarea
                className="nj-textarea"
                placeholder={"이 뉴스를 왜 중요하다고 봤는지 적어주세요.\n1) ...\n2) ..."}
                value={fSummary}
                onChange={(ev) => setFSummary(ev.target.value)}
              />
            </div>

            <button className="nj-savebtn" onClick={handleSave}>
              {editingId ? "수정 완료" : "저장"}
            </button>
          </div>
        </div>
      )}

      {manualCopyText && (
        <div className="nj-copy-fallback">
          <div className="nj-copy-fallback-inner">
            <p>자동 복사가 지원되지 않아요. 아래 텍스트를 직접 선택해 복사해주세요.</p>
            <textarea readOnly value={manualCopyText} onFocus={(e) => e.target.select()} />
            <button className="nj-copy-fallback-close" onClick={() => setManualCopyText(null)}>
              닫기
            </button>
          </div>
        </div>
      )}

      {toast && <div className="nj-toast">{toast}</div>}
    </div>
  );
}
