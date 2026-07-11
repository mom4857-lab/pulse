import { useState, useEffect, useRef } from "react";
import { X, Link2, Plus, Copy, Download, ChevronLeft, ChevronRight, Activity, RefreshCw, Pencil } from "lucide-react";
import { storage } from "./storage.js";

const STORAGE_KEY = "news-journal-entries";
const ANALYSIS_KEY = "news-journal-period-analyses";

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
function getPeriodKey(type, refDate) {
  if (type === "year") return `year:${refDate.getFullYear()}`;
  if (type === "month") return `month:${refDate.getFullYear()}-${String(refDate.getMonth() + 1).padStart(2, "0")}`;
  const s = startOfWeek(refDate);
  return `week:${s.getFullYear()}-${String(s.getMonth() + 1).padStart(2, "0")}-${String(s.getDate()).padStart(2, "0")}`;
}

// ---------- tag helpers ----------
function tagsForCategory(entry, category) {
  if (category === "industry") return entry.industryTags || [];
  if (category === "stock") return entry.stockTags || [];
  return entry.techTags || [];
}
function categoryLabel(category) {
  if (category === "industry") return "산업군";
  if (category === "stock") return "종목";
  return "기술/제품/기타";
}
function getTagCounts(list, category) {
  const counts = {};
  list.forEach((e) => {
    tagsForCategory(e, category).forEach((t) => {
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
function heatSize(count, max) {
  const min = 58,
    maxSize = 168;
  if (max <= 1) return 96;
  return Math.round(min + (count / max) * (maxSize - min));
}
function hashRotate(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
  return (Math.abs(h) % 9) - 4;
}
function tierColor(rankIndex, category) {
  if (category === "industry") return "var(--teal)";
  if (rankIndex < 5) return "var(--tier1)";
  if (rankIndex < 10) return "var(--tier2)";
  return "var(--tier3)";
}
function decodeEntities(str) {
  const el = document.createElement("textarea");
  el.innerHTML = str;
  return el.value;
}
const NO_MARKER_PREFIX = "\u2063";
function parseSummaryLines(summary) {
  return (summary || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => (line.startsWith(NO_MARKER_PREFIX) ? line.slice(NO_MARKER_PREFIX.length) : line))
    .map((line) => line.replace(/^([*\-•]|\d+[).])\s*/, ""));
}
function parseSummaryLinesRich(summary) {
  return (summary || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const noMarker = line.startsWith(NO_MARKER_PREFIX);
      const clean = (noMarker ? line.slice(NO_MARKER_PREFIX.length) : line).replace(/^([*\-•]|\d+[).])\s*/, "");
      return { text: clean, noMarker };
    });
}
function splitKoreanSentences(text) {
  if (!text) return [];
  return text
    .split(/(?<=다[.!?])\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
}
function makeLineId() {
  return "l" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}
function linesFromSummaryText(summary) {
  const parsed = parseSummaryLinesRich(summary);
  if (parsed.length === 0) return [{ id: makeLineId(), text: "", noMarker: false }];
  return parsed.map(({ text, noMarker }) => ({ id: makeLineId(), text, noMarker }));
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
  const [periodAnalyses, setPeriodAnalyses] = useState({});
  const [entryKwLoading, setEntryKwLoading] = useState({});
  const [analyzing, setAnalyzing] = useState(false);
  const [showPeriodPicker, setShowPeriodPicker] = useState(false);
  const [cloudView, setCloudView] = useState("list");
  const listRef = useRef(null);
  const overlayMouseDownOnBackdrop = useRef(false);

  // form state
  const [fUrl, setFUrl] = useState("");
  const [fTitle, setFTitle] = useState("");
  const [fDate, setFDate] = useState(todayStr());
  const [fIndustryInput, setFIndustryInput] = useState("");
  const [fStockInput, setFStockInput] = useState("");
  const [fTechInput, setFTechInput] = useState("");
  const [fIndustryTags, setFIndustryTags] = useState([]);
  const [fStockTags, setFStockTags] = useState([]);
  const [fTechTags, setFTechTags] = useState([]);
  const [fSummaryLines, setFSummaryLines] = useState(() => [{ id: makeLineId(), text: "" }]);
  const lineInputRefs = useRef({});

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
      try {
        const res2 = await storage.get(ANALYSIS_KEY);
        setPeriodAnalyses(res2 ? JSON.parse(res2.value) : {});
      } catch (e) {
        setPeriodAnalyses({});
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

  async function persistAnalyses(next) {
    setPeriodAnalyses(next);
    try {
      const ok = await storage.set(ANALYSIS_KEY, JSON.stringify(next));
      if (!ok) showToast("저장에 실패했어요. 다시 시도해주세요.");
    } catch (e) {
      showToast("저장 중 오류가 발생했어요.");
    }
  }

  function removeEntryTag(entryId, tag, category) {
    const field = category === "industry" ? "industryTags" : category === "stock" ? "stockTags" : "techTags";
    patchEntry(entryId, (e) => ({
      [field]: (e[field] || []).filter((t) => t !== tag),
    }));
  }

  async function requestEntryKeywords(entry) {
    setEntryKwLoading((s) => ({ ...s, [entry.id]: true }));
    try {
      const bulletText = parseSummaryLines(entry.summary).join(" / ");
      const res = await fetch("/api/entry-keywords", {
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
        const reason =
          data && (data.error || data.detail) ? `${data.error || ""} ${data.detail || ""}`.trim() : `status ${res.status}`;
        throw new Error(reason);
      }
      patchEntry(entry.id, {
        aiStockKeywords: Array.isArray(data.stockKeywords) ? data.stockKeywords : [],
        aiTechKeywords: Array.isArray(data.techKeywords) ? data.techKeywords : [],
      });
    } catch (e) {
      showToast(`AI 키워드 추천 실패: ${String(e.message || e).slice(0, 160)}`, 9000);
    } finally {
      setEntryKwLoading((s) => {
        const next = { ...s };
        delete next[entry.id];
        return next;
      });
    }
  }

  function addSuggestedKeyword(entryId, keyword, category) {
    const field = category === "industry" ? "industryTags" : category === "stock" ? "stockTags" : "techTags";
    const suggestField = category === "industry" ? "aiIndustryKeywords" : category === "stock" ? "aiStockKeywords" : "aiTechKeywords";
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
    setFTechInput("");
    setFIndustryTags([]);
    setFStockTags([]);
    setFTechTags([]);
    setFSummaryLines([{ id: makeLineId(), text: "" }]);
    lineInputRefs.current = {};
  }

  function openEdit(entry) {
    setEditingId(entry.id);
    setFUrl(entry.url || "");
    setFTitle(entry.title || "");
    setFDate(entry.date || todayStr());
    setFIndustryInput("");
    setFStockInput("");
    setFTechInput("");
    setFIndustryTags(entry.industryTags || []);
    setFStockTags(entry.stockTags || []);
    setFTechTags(entry.techTags || []);
    setFSummaryLines(linesFromSummaryText(entry.summary || ""));
    lineInputRefs.current = {};
    setShowForm(true);
  }

  function updateLineText(id, text) {
    setFSummaryLines((lines) => lines.map((l) => (l.id === id ? { ...l, text } : l)));
  }

  function handleLineKeyDown(id, e) {
    const idx = fSummaryLines.findIndex((l) => l.id === id);
    if (idx === -1) return;

    if (e.key === "Enter" && e.altKey) {
      e.preventDefault();
      setFSummaryLines((lines) => lines.map((l) => (l.id === id ? { ...l, noMarker: !l.noMarker } : l)));
      return;
    }

    if (e.key === "Enter") {
      e.preventDefault();
      const input = e.target;
      const cursor = input.selectionStart ?? fSummaryLines[idx].text.length;
      const text = fSummaryLines[idx].text;
      const before = text.slice(0, cursor);
      const after = text.slice(cursor);
      const newId = makeLineId();
      const newLines = fSummaryLines.slice();
      newLines[idx] = { ...newLines[idx], text: before };
      newLines.splice(idx + 1, 0, { id: newId, text: after });
      setFSummaryLines(newLines);
      requestAnimationFrame(() => {
        const el = lineInputRefs.current[newId];
        if (el) {
          el.focus();
          el.setSelectionRange(0, 0);
        }
      });
    } else if (e.key === "Backspace") {
      const input = e.target;
      if (input.selectionStart === 0 && input.selectionEnd === 0 && idx > 0) {
        e.preventDefault();
        const prevLine = fSummaryLines[idx - 1];
        const mergedText = prevLine.text + fSummaryLines[idx].text;
        const mergeCursor = prevLine.text.length;
        const newLines = fSummaryLines.filter((_, i) => i !== idx);
        newLines[idx - 1] = { ...prevLine, text: mergedText };
        setFSummaryLines(newLines);
        requestAnimationFrame(() => {
          const el = lineInputRefs.current[prevLine.id];
          if (el) {
            el.focus();
            el.setSelectionRange(mergeCursor, mergeCursor);
          }
        });
      }
    } else if (e.key === "ArrowUp") {
      if (idx > 0) {
        e.preventDefault();
        const targetId = fSummaryLines[idx - 1].id;
        requestAnimationFrame(() => lineInputRefs.current[targetId]?.focus());
      }
    } else if (e.key === "ArrowDown") {
      if (idx < fSummaryLines.length - 1) {
        e.preventDefault();
        const targetId = fSummaryLines[idx + 1].id;
        requestAnimationFrame(() => lineInputRefs.current[targetId]?.focus());
      }
    }
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

  function getKeywordSuggestions(query, allTags, currentTags) {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const already = new Set(currentTags.map((t) => t.toLowerCase()));
    const seen = new Set();
    const matches = [];
    for (const tag of allTags) {
      const tagLower = tag.toLowerCase();
      if (already.has(tagLower) || seen.has(tagLower)) continue;
      if (tagLower.includes(q)) {
        matches.push(tag);
        seen.add(tagLower);
      }
      if (matches.length >= 6) break;
    }
    return matches;
  }

  const [editingSection, setEditingSection] = useState(null);
  const [editingSectionText, setEditingSectionText] = useState("");

  useEffect(() => {
    setEditingSection(null);
  }, [periodType, refDate]);

  function startEditSection(field, currentValue) {
    setEditingSection(field);
    setEditingSectionText(field === "keywords" ? (currentValue || []).join(", ") : currentValue || "");
  }

  function cancelEditSection() {
    setEditingSection(null);
  }

  function saveEditSection() {
    const key = getPeriodKey(periodType, refDate);
    const current = periodAnalyses[key] || {};
    let value;
    if (editingSection === "keywords") {
      value = editingSectionText
        .split(/[,\n]/)
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 5);
    } else {
      value = editingSectionText.trim();
    }
    const next = { ...periodAnalyses, [key]: { ...current, [editingSection]: value } };
    persistAnalyses(next);
    setEditingSection(null);
  }

  async function requestPeriodAnalysis() {
    if (periodEntries.length === 0) {
      showToast("이 기간에는 분석할 기록이 없어요.");
      return;
    }
    const key = getPeriodKey(periodType, refDate);
    setAnalyzing(true);
    try {
      const payload = {
        periodLabel: periodLabel(periodType, refDate),
        periodType,
        entries: periodEntries.map((e) => ({
          date: e.date,
          title: e.title,
          url: e.url,
          summary: parseSummaryLines(e.summary).join("\n"),
          industryTags: e.industryTags || [],
          stockTags: e.stockTags || [],
          techTags: e.techTags || [],
        })),
      };
      const res = await fetch("/api/analyze-period", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      let data = null;
      try {
        data = await res.json();
      } catch (parseErr) {
        throw new Error(`서버 응답을 읽을 수 없어요 (status ${res.status})`);
      }
      if (!res.ok) {
        const reason =
          data && (data.error || data.detail) ? `${data.error || ""} ${data.detail || ""}`.trim() : `status ${res.status}`;
        throw new Error(reason);
      }
      if (!data.coreFlow && !data.connections && !data.signals) throw new Error("분석 결과가 비어 있어요.");
      const next = {
        ...periodAnalyses,
        [key]: {
          coreFlow: data.coreFlow || "",
          connections: data.connections || "",
          signals: data.signals || "",
          keywords: Array.isArray(data.keywords) ? data.keywords : [],
          generatedAt: Date.now(),
          entryCount: periodEntries.length,
        },
      };
      persistAnalyses(next);
    } catch (e) {
      showToast(`AI 총정리 실패: ${String(e.message || e).slice(0, 160)}`, 9000);
    } finally {
      setAnalyzing(false);
    }
  }

  function handleSave() {
    const fSummary = fSummaryLines
      .filter((l) => l.text.trim())
      .map((l) => (l.noMarker ? NO_MARKER_PREFIX : "") + l.text.trim())
      .join("\n");
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
      const urlChanged = original && (original.url || "") !== fUrl.trim();
      const updatedEntry = {
        ...original,
        date: fDate,
        url: fUrl.trim(),
        title: fTitle.trim() || "(제목 없음)",
        industryTags: fIndustryTags,
        stockTags: fStockTags,
        techTags: fTechTags,
        summary: fSummary.trim(),
      };
      const updated = entries.map((e) => (e.id === editingId ? updatedEntry : e));
      persist(updated);
      resetForm();
      setShowForm(false);
      showToast("기록을 수정했어요.");
      if (summaryChanged || urlChanged) requestEntryKeywords(updatedEntry);
      return;
    }
    const entry = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      date: fDate,
      url: fUrl.trim(),
      title: fTitle.trim() || "(제목 없음)",
      industryTags: fIndustryTags,
      stockTags: fStockTags,
      techTags: fTechTags,
      summary: fSummary.trim(),
      createdAt: Date.now(),
    };
    persist([...entries, entry]);
    resetForm();
    setShowForm(false);
    showToast("기록을 저장했어요.");
    requestEntryKeywords(entry);
  }

  function handleDelete(id) {
    persist(entries.filter((e) => e.id !== id));
    setConfirmDeleteId(null);
    showToast("삭제했어요.");
  }

  const allIndustryTagsUsed = Array.from(new Set(entries.flatMap((e) => e.industryTags || [])));
  const allStockTagsUsed = Array.from(new Set(entries.flatMap((e) => e.stockTags || [])));
  const allTechTagsUsed = Array.from(new Set(entries.flatMap((e) => e.techTags || [])));

  const periodEntries = entries.filter((e) => isInPeriod(e.date, periodType, refDate));
  const displayedEntries = (selectedTag
    ? periodEntries.filter((e) => tagsForCategory(e, category).includes(selectedTag))
    : periodEntries
  )
    .slice()
    .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt);

  const tagCounts = getTagCounts(periodEntries, category);
  const maxCount = tagCounts.length ? tagCounts[0][1] : 1;

  function buildBlogText() {
    const industryCounts = getTagCounts(periodEntries, "industry");
    const stockCounts = getTagCounts(periodEntries, "stock");
    const techCounts = getTagCounts(periodEntries, "tech");
    const key = getPeriodKey(periodType, refDate);
    const analysis = periodAnalyses[key];
    let text = `📅 ${periodLabel(periodType, refDate)} 뉴스 노트\n\n`;
    if (analysis && (analysis.coreFlow || analysis.connections || analysis.signals)) {
      text += `🧠 AI 총정리\n`;
      if (analysis.coreFlow) text += `▪ 핵심 흐름: ${analysis.coreFlow}\n`;
      if (analysis.connections) text += `▪ 연결고리 및 반복 주제: ${analysis.connections}\n`;
      if (analysis.signals) text += `▪ 주목할 신호: ${analysis.signals}\n`;
      if (analysis.keywords && analysis.keywords.length) {
        text += `▪ 관련 키워드: ${analysis.keywords.map((k) => "#" + k).join(" ")}\n`;
      }
      text += "\n";
    }
    periodEntries
      .slice()
      .sort((a, b) => a.date.localeCompare(b.date))
      .forEach((e) => {
        text += `[${e.date}] ${e.title}\n`;
        text += `${parseSummaryLines(e.summary).join("\n")}\n`;
        if (e.url) text += `🔗 ${e.url}\n`;
        const allTags = [...(e.industryTags || []), ...(e.stockTags || []), ...(e.techTags || [])];
        if (allTags.length) text += allTags.map((t) => "#" + t).join(" ") + "\n";
        text += "\n";
      });
    text += `---\n📊 이번 기간 주요 키워드\n`;
    text += `산업군: ${industryCounts.map(([t, c]) => `${t}(${c})`).join(", ") || "없음"}\n`;
    text += `종목: ${stockCounts.map(([t, c]) => `${t}(${c})`).join(", ") || "없음"}\n`;
    text += `기술/제품/기타: ${techCounts.map(([t, c]) => `${t}(${c})`).join(", ") || "없음"}\n`;
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

  function selectTagAndScroll(tag) {
    const next = selectedTag === tag ? null : tag;
    setSelectedTag(next);
    if (next) scrollToList();
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
          --tier1: #fb7185;
          --tier2: #a78bfa;
          --tier3: #64748b;
          --gold: #f2b84b;
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
        .nj-nav .nj-label {
          min-width: 170px; text-align: center; font-weight: 600; color: var(--text); font-family: 'Inter', sans-serif;
          background: none; border: none; cursor: pointer; padding: 4px 8px; border-radius: 6px; transition: background .15s ease;
        }
        .nj-nav .nj-label:hover { background: var(--surface-raised); }
        .nj-picker-overlay {
          position: fixed; inset: 0; background: rgba(4,6,10,0.5); display: flex;
          align-items: flex-start; justify-content: center; z-index: 60; padding-top: 160px;
        }
        .nj-picker-box {
          background: var(--surface); border: 1px solid var(--line); border-radius: 12px; padding: 16px 18px;
          box-shadow: 0 20px 50px rgba(0,0,0,0.4); min-width: 220px; animation: nj-pop-in .15s ease;
        }

        .nj-rank-panel {
          background: var(--surface); border: 1px solid var(--line); border-radius: 14px;
          padding: 16px 18px; margin-bottom: 14px;
        }
        .nj-rank-title { font-size: 12px; font-family: 'JetBrains Mono', monospace; color: var(--text-soft); font-weight: 700; letter-spacing: 0.03em; margin-bottom: 10px; }
        .nj-rank-row { display: flex; align-items: center; gap: 10px; padding: 5px 0; cursor: pointer; }
        .nj-rank-index { flex: none; width: 18px; font-size: 11.5px; font-family: 'JetBrains Mono', monospace; color: var(--text-soft); text-align: right; }
        .nj-rank-label { flex: none; width: 108px; font-size: 12.5px; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .nj-rank-bar-track { flex: 1; height: 9px; background: var(--surface-raised); border-radius: 5px; overflow: hidden; }
        .nj-rank-bar-fill { height: 100%; border-radius: 5px; transition: width .25s ease; }
        .nj-rank-count { flex: none; width: 28px; text-align: right; font-size: 11.5px; font-family: 'JetBrains Mono', monospace; color: var(--text-soft); }
        .nj-rank-row:hover .nj-rank-label { color: var(--teal); }

        .nj-cloud-panel-wrap { position: relative; margin-bottom: 14px; }
        .nj-cloud-panel-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
        .nj-cloud-panel-caption { font-size: 12px; color: var(--text-soft); font-family: 'JetBrains Mono', monospace; }

        .nj-cloud-panel {
          background: radial-gradient(120% 140% at 50% 0%, rgba(45,212,191,0.07), transparent 60%), var(--surface);
          border: 1px solid var(--line); border-radius: 14px;
          padding: 32px 20px; min-height: 190px; display: flex; align-items: center; justify-content: center;
          flex-wrap: wrap; gap: 10px 14px; overflow: hidden; position: relative;
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
        .nj-stamp-count {
          position: absolute; top: -7px; right: -7px; font-size: 10px; line-height: 1;
          padding: 2px 5px; border-radius: 999px; background: var(--bg); border: 1px solid currentColor;
          font-family: 'JetBrains Mono', monospace; font-weight: 700;
        }

        .nj-heat-box {
          display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px;
          border-radius: 8px; cursor: pointer; transition: transform .15s ease; color: var(--bg); padding: 4px;
          box-sizing: border-box;
        }
        .nj-heat-box:hover { transform: scale(1.04); }
        .nj-heat-box.selected { outline: 2px solid var(--text); }
        .nj-heat-tag { font-size: 12px; font-weight: 700; text-align: center; line-height: 1.2; word-break: keep-all; }
        .nj-heat-count { font-size: 10.5px; font-family: 'JetBrains Mono', monospace; opacity: 0.85; }

        .nj-cat-industry .nj-stamp { box-shadow: 0 0 12px rgba(45,212,191,0.18); }
        .nj-cat-stock .nj-stamp { box-shadow: 0 0 12px rgba(167,139,250,0.18); }
        .nj-cat-tech .nj-stamp { box-shadow: 0 0 12px rgba(242,184,75,0.18); }

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
        .nj-period-analysis {
          background: radial-gradient(120% 140% at 50% 0%, rgba(167,139,250,0.08), transparent 60%), var(--surface);
          border: 1px solid var(--line); border-radius: 14px; padding: 16px 18px; margin-bottom: 16px;
        }
        .nj-period-analysis-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
        .nj-period-analysis-title { display: flex; align-items: center; gap: 7px; font-size: 12px; font-family: 'JetBrains Mono', monospace; color: var(--violet); font-weight: 700; letter-spacing: 0.03em; }
        .nj-ai-refresh-btn { border: none; background: none; color: var(--text-soft); cursor: pointer; display: flex; align-items: center; padding: 3px; border-radius: 5px; transition: color .15s ease, background .15s ease; }
        .nj-ai-refresh-btn:hover:not(:disabled) { color: var(--violet); background: rgba(167,139,250,0.12); }
        .nj-ai-refresh-btn:disabled { opacity: 0.4; cursor: default; }
        .nj-ai-refresh-btn.spinning svg { animation: nj-spin 1s linear infinite; }
        .nj-period-analysis-body { font-size: 13.5px; line-height: 1.75; color: var(--text); white-space: pre-wrap; }
        .nj-period-analysis-body.muted { color: var(--text-soft); font-size: 13px; }
        .nj-analysis-section { padding: 9px 0 9px 12px; border-bottom: 1px dashed var(--line); border-left: 3px solid transparent; margin-bottom: 2px; }
        .nj-analysis-section:last-of-type { border-bottom: none; padding-bottom: 4px; }
        .nj-analysis-section-title { font-size: 11px; font-weight: 700; letter-spacing: 0.03em; margin-bottom: 4px; font-family: 'JetBrains Mono', monospace; }
        .nj-analysis-section-title-row { display: flex; align-items: center; justify-content: space-between; }
        .nj-section-edit-btn { border: none; background: none; color: var(--text-soft); cursor: pointer; opacity: 0.55; padding: 2px; display: flex; align-items: center; transition: opacity .15s ease, color .15s ease; }
        .nj-section-edit-btn:hover { opacity: 1; color: var(--teal); }
        .nj-section-edit-box { margin-top: 4px; }
        .nj-section-edit-box .nj-textarea { min-height: 70px; }
        .nj-section-edit-actions { display: flex; gap: 12px; margin-top: 6px; }
        .nj-oneline-btn.muted { color: var(--text-soft); }
        .nj-analysis-section.core { border-left-color: var(--teal); }
        .nj-analysis-section.core .nj-analysis-section-title { color: var(--teal); }
        .nj-analysis-section.core .nj-summary-marker { background: var(--teal); }
        .nj-analysis-section.connections { border-left-color: var(--violet); }
        .nj-analysis-section.connections .nj-analysis-section-title { color: var(--violet); }
        .nj-analysis-section.connections .nj-summary-marker { background: var(--violet); }
        .nj-analysis-section.signals { border-left-color: var(--rose); }
        .nj-analysis-section.signals .nj-analysis-section-title { color: var(--rose); }
        .nj-analysis-section.signals .nj-summary-marker { background: var(--rose); }
        .nj-analysis-section.keywords { border-left-color: #f2b84b; }
        .nj-analysis-section.keywords .nj-analysis-section-title { color: #f2b84b; }
        .nj-period-kw-row { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 4px; }
        .nj-period-kw-chip {
          font-size: 12px; padding: 3px 10px; border-radius: 999px; font-family: 'JetBrains Mono', monospace;
          color: var(--violet); background: rgba(167,139,250,0.12); border: 1px solid rgba(167,139,250,0.35);
        }
        .nj-oneline-btn { border: none; background: none; color: var(--violet); font-size: 12.5px; cursor: pointer; padding: 0; margin-left: 8px; font-family: 'Inter', sans-serif; }
        .nj-oneline-btn:hover { text-decoration: underline; }
        .nj-period-analysis-meta { font-size: 11px; color: var(--text-soft); margin-top: 8px; font-family: 'JetBrains Mono', monospace; }
        .nj-entry-ai-kw { margin-top: 10px; padding-top: 10px; border-top: 1px dashed var(--line); }
        .nj-entry-ai-kw-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; }
        .nj-entry-ai-kw-label { font-size: 11px; font-family: 'JetBrains Mono', monospace; color: var(--violet); font-weight: 700; letter-spacing: 0.03em; }
        .nj-ai-kw-row { display: flex; flex-wrap: wrap; gap: 6px; }
        .nj-ai-kw-chip {
          display: inline-flex; align-items: center; gap: 5px; font-size: 11px; padding: 3px 5px 3px 10px;
          border-radius: 999px; font-family: 'JetBrains Mono', monospace; border: 1px dashed;
        }
        .nj-ai-kw-chip.industry { color: var(--teal); border-color: rgba(45,212,191,0.45); background: rgba(45,212,191,0.06); }
        .nj-ai-kw-chip.stock { color: var(--violet); border-color: rgba(167,139,250,0.45); background: rgba(167,139,250,0.06); }
        .nj-ai-kw-chip.tech { color: var(--gold); border-color: rgba(242,184,75,0.45); background: rgba(242,184,75,0.06); }
        .nj-kw-add-btn {
          border: none; background: rgba(255,255,255,0.1); color: inherit; width: 16px; height: 16px; border-radius: 50%;
          font-size: 10px; font-weight: 700; cursor: pointer; display: flex; align-items: center; justify-content: center;
          line-height: 1; padding: 0; font-family: 'Inter', sans-serif;
        }
        .nj-kw-add-btn:hover { background: currentColor; color: var(--bg); }
        .nj-entry-tags { display: flex; flex-wrap: wrap; gap: 6px; margin: 6px 0 2px; }
        .nj-chip {
          display: inline-flex; align-items: center; gap: 5px; font-size: 11.5px; padding: 2px 5px 2px 9px;
          border-radius: 999px; font-family: 'JetBrains Mono', monospace;
        }
        .nj-chip.industry { background: rgba(45,212,191,0.12); color: var(--teal); }
        .nj-chip.stock { background: rgba(167,139,250,0.14); color: var(--violet); }
        .nj-chip.tech { background: rgba(242,184,75,0.14); color: var(--gold); }
        .nj-chip-remove {
          border: none; background: none; color: inherit; opacity: 0.55; cursor: pointer;
          display: flex; align-items: center; padding: 0; transition: opacity .15s ease, color .15s ease;
        }
        .nj-chip-remove:hover { opacity: 1; color: var(--rose); }
        .nj-entry-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 4px; }
        .nj-entry-actions button { font-size: 11.5px; border: none; background: none; color: var(--text-soft); cursor: pointer; }
        .nj-entry-actions button:hover { color: var(--rose); }
        .nj-empty-list { text-align: center; padding: 30px 10px; color: var(--text-soft); font-size: 13.5px; }

        .nj-modal-overlay {
          position: fixed; inset: 0; background: rgba(4,6,10,0.65); backdrop-filter: blur(3px);
          z-index: 50; overflow: auto; text-align: center; padding: 48px 16px;
        }
        .nj-modal {
          display: inline-block; text-align: left; vertical-align: top;
          background: var(--surface); border: 1px solid var(--line); border-radius: 16px; width: 1060px; max-width: 92vw;
          height: auto; max-height: 80vh; min-width: 340px; min-height: 320px; overflow: auto;
          padding: 22px 22px 26px; box-shadow: 0 20px 60px rgba(0,0,0,0.5);
          animation: nj-pop-in .18s ease; resize: both;
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
        .nj-bullet-editor {
          border: 1px solid var(--line); background: var(--surface-raised); border-radius: 8px;
          padding: 8px 10px; min-height: 110px;
        }
        .nj-bullet-row { display: flex; align-items: center; gap: 9px; padding: 3px 0; }
        .nj-bullet-input {
          flex: 1; border: none; background: none; outline: none; color: var(--text);
          font-family: 'Inter', sans-serif; font-size: 13.5px; padding: 2px 0;
        }
        .nj-bullet-input::placeholder { color: var(--text-soft); }
        .nj-field-gap { margin-top: 8px; }
        .nj-mini-label { font-size: 11.5px; color: var(--text-soft); margin-bottom: 4px; }
        .nj-chips-input { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
        .nj-kw-suggest-list { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
        .nj-kw-suggest-item {
          font-size: 11.5px; padding: 3px 10px; border-radius: 999px; border: 1px dashed var(--line);
          background: var(--surface-raised); color: var(--text-soft); cursor: pointer; font-family: 'JetBrains Mono', monospace;
          transition: border-color .15s ease, color .15s ease;
        }
        .nj-kw-suggest-item.industry:hover { border-color: var(--teal); color: var(--teal); }
        .nj-kw-suggest-item.stock:hover { border-color: var(--violet); color: var(--violet); }
        .nj-kw-suggest-item.tech:hover { border-color: var(--gold); color: var(--gold); }
        .nj-chip-editable {
          display: flex; align-items: center; gap: 5px; font-size: 12px; padding: 3px 8px 3px 10px;
          border-radius: 999px; font-family: 'JetBrains Mono', monospace;
        }
        .nj-chip-editable.industry { background: rgba(45,212,191,0.14); color: var(--teal); }
        .nj-chip-editable.stock { background: rgba(167,139,250,0.16); color: var(--violet); }
        .nj-chip-editable.tech { background: rgba(242,184,75,0.16); color: var(--gold); }
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
        @keyframes nj-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }

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
            <button className="nj-label" onClick={() => setShowPeriodPicker(true)}>
              {periodLabel(periodType, refDate)}
            </button>
            <button onClick={() => setRefDate(shiftRef(periodType, refDate, 1))}>
              <ChevronRight size={15} />
            </button>
          </div>
          <div className="nj-seg">
            {[
              ["industry", "산업군"],
              ["stock", "종목"],
              ["tech", "기술/제품/기타"],
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

        {showPeriodPicker && (
          <div className="nj-picker-overlay" onClick={(e) => e.target === e.currentTarget && setShowPeriodPicker(false)}>
            <div className="nj-picker-box">
              {periodType === "year" && (
                <>
                  <div className="nj-mini-label">연도 선택</div>
                  <select
                    className="nj-input"
                    value={refDate.getFullYear()}
                    onChange={(ev) => {
                      const y = parseInt(ev.target.value, 10);
                      setRefDate(new Date(y, refDate.getMonth(), 1));
                      setShowPeriodPicker(false);
                    }}
                  >
                    {Array.from(
                      new Set([
                        ...entries.map((e) => new Date(e.date + "T00:00:00").getFullYear()),
                        new Date().getFullYear(),
                        refDate.getFullYear(),
                      ])
                    )
                      .sort((a, b) => b - a)
                      .map((y) => (
                        <option key={y} value={y}>
                          {y}년
                        </option>
                      ))}
                  </select>
                </>
              )}
              {periodType === "month" && (
                <>
                  <div className="nj-mini-label">월 선택</div>
                  <input
                    type="month"
                    className="nj-input"
                    value={`${refDate.getFullYear()}-${String(refDate.getMonth() + 1).padStart(2, "0")}`}
                    onChange={(ev) => {
                      const [y, m] = ev.target.value.split("-").map(Number);
                      if (y && m) {
                        setRefDate(new Date(y, m - 1, 1));
                        setShowPeriodPicker(false);
                      }
                    }}
                  />
                </>
              )}
              {periodType === "week" && (
                <>
                  <div className="nj-mini-label">이 날짜가 포함된 주로 이동</div>
                  <input
                    type="date"
                    className="nj-input"
                    defaultValue={`${refDate.getFullYear()}-${String(refDate.getMonth() + 1).padStart(2, "0")}-${String(
                      refDate.getDate()
                    ).padStart(2, "0")}`}
                    onChange={(ev) => {
                      if (ev.target.value) {
                        setRefDate(new Date(ev.target.value + "T00:00:00"));
                        setShowPeriodPicker(false);
                      }
                    }}
                  />
                </>
              )}
            </div>
          </div>
        )}

        <div className="nj-rank-panel">
          <div className="nj-rank-title">TOP 10 · {categoryLabel(category)} 키워드</div>
          {tagCounts.length === 0 ? (
            <div className="nj-cloud-empty">이 기간에는 아직 키워드가 없어요.</div>
          ) : (
            tagCounts.slice(0, 10).map(([tag, count], idx) => (
              <div className="nj-rank-row" key={tag} onClick={() => selectTagAndScroll(tag)}>
                <span className="nj-rank-index">{idx + 1}</span>
                <span className="nj-rank-label">{tag}</span>
                <div className="nj-rank-bar-track">
                  <div
                    className="nj-rank-bar-fill"
                    style={{ width: `${(count / maxCount) * 100}%`, background: tierColor(idx, category) }}
                  />
                </div>
                <span className="nj-rank-count">{count}</span>
              </div>
            ))
          )}
        </div>

        <div className="nj-cloud-panel-wrap">
          <div className="nj-cloud-panel-head">
            <span className="nj-cloud-panel-caption">{categoryLabel(category)} 키워드 지도</span>
            <div className="nj-seg">
              <button className={cloudView === "list" ? "active" : ""} onClick={() => setCloudView("list")}>
                나열
              </button>
              <button className={cloudView === "heatmap" ? "active" : ""} onClick={() => setCloudView("heatmap")}>
                히트맵
              </button>
            </div>
          </div>
          <div
            className={`nj-cloud-panel ${
              category === "industry" ? "nj-cat-industry" : category === "stock" ? "nj-cat-stock" : "nj-cat-tech"
            }`}
          >
            {!loaded ? (
              <div className="nj-cloud-empty">불러오는 중...</div>
            ) : tagCounts.length === 0 ? (
              <div className="nj-cloud-empty">이 기간에는 아직 {categoryLabel(category)} 키워드가 없어요.</div>
            ) : cloudView === "list" ? (
              tagCounts.map(([tag, count], idx) => (
                <span
                  key={tag}
                  className={`nj-stamp${selectedTag === tag ? " selected" : ""}`}
                  style={{
                    fontSize: scaleSize(count, maxCount),
                    opacity: selectedTag && selectedTag !== tag ? 0.35 : scaleOpacity(count, maxCount),
                    transform: `rotate(${hashRotate(tag)}deg)`,
                    color: tierColor(idx, category),
                  }}
                  onClick={() => selectTagAndScroll(tag)}
                  title={`${count}건`}
                >
                  <span>{tag}</span>
                  <span className="nj-stamp-count">{count}</span>
                </span>
              ))
            ) : (
              tagCounts.map(([tag, count], idx) => {
                const side = heatSize(count, maxCount);
                return (
                  <div
                    key={tag}
                    className={`nj-heat-box${selectedTag === tag ? " selected" : ""}`}
                    style={{
                      width: side,
                      height: side,
                      background: tierColor(idx, category),
                      opacity: selectedTag && selectedTag !== tag ? 0.35 : scaleOpacity(count, maxCount),
                    }}
                    onClick={() => selectTagAndScroll(tag)}
                    title={`${count}건`}
                  >
                    <span className="nj-heat-tag">{tag}</span>
                    <span className="nj-heat-count">{count}</span>
                  </div>
                );
              })
            )}
          </div>
        </div>

        <div className="nj-period-analysis">
          <div className="nj-period-analysis-head">
            <span className="nj-period-analysis-title">
              <Activity size={12} /> AI 총정리 · {periodLabel(periodType, refDate)}
            </span>
            <button
              className={`nj-ai-refresh-btn${analyzing ? " spinning" : ""}`}
              title="AI 총정리 생성 · 새로고침"
              onClick={requestPeriodAnalysis}
              disabled={analyzing || periodEntries.length === 0}
            >
              <RefreshCw size={13} />
            </button>
          </div>
          {(() => {
            const key = getPeriodKey(periodType, refDate);
            const current = periodAnalyses[key];
            if (analyzing) {
              return <div className="nj-period-analysis-body muted">이 기간 기록을 분석하는 중...</div>;
            }
            if (current && (current.coreFlow || current.connections || current.signals)) {
              const renderTextSection = (field, title, cls) => {
                const value = current[field];
                if (!value && editingSection !== field) return null;
                return (
                  <div className={`nj-analysis-section ${cls}`} key={field}>
                    <div className="nj-analysis-section-title-row">
                      <div className="nj-analysis-section-title">{title}</div>
                      {editingSection !== field && (
                        <button className="nj-section-edit-btn" title="직접 수정" onClick={() => startEditSection(field, value)}>
                          <Pencil size={11} />
                        </button>
                      )}
                    </div>
                    {editingSection === field ? (
                      <div className="nj-section-edit-box">
                        <textarea
                          className="nj-textarea"
                          value={editingSectionText}
                          onChange={(ev) => setEditingSectionText(ev.target.value)}
                          autoFocus
                        />
                        <div className="nj-section-edit-actions">
                          <button className="nj-oneline-btn" onClick={saveEditSection}>
                            저장
                          </button>
                          <button className="nj-oneline-btn muted" onClick={cancelEditSection}>
                            취소
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="nj-period-analysis-body">
                        {splitKoreanSentences(value).map((sentence, i) => (
                          <div className="nj-summary-line" key={i}>
                            <span className="nj-summary-marker" />
                            <span>{sentence}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              };
              return (
                <>
                  {renderTextSection("coreFlow", "핵심 흐름", "core")}
                  {renderTextSection("connections", "연결고리 및 반복 주제", "connections")}
                  {renderTextSection("signals", "주목할 신호", "signals")}
                  {(current.keywords?.length > 0 || editingSection === "keywords") && (
                    <div className="nj-analysis-section keywords">
                      <div className="nj-analysis-section-title-row">
                        <div className="nj-analysis-section-title">관련 키워드 추천 (기사 본문 기반)</div>
                        {editingSection !== "keywords" && (
                          <button
                            className="nj-section-edit-btn"
                            title="직접 수정"
                            onClick={() => startEditSection("keywords", current.keywords)}
                          >
                            <Pencil size={11} />
                          </button>
                        )}
                      </div>
                      {editingSection === "keywords" ? (
                        <div className="nj-section-edit-box">
                          <input
                            className="nj-input"
                            value={editingSectionText}
                            onChange={(ev) => setEditingSectionText(ev.target.value)}
                            placeholder="쉼표로 구분해서 입력 (최대 5개)"
                            autoFocus
                          />
                          <div className="nj-section-edit-actions">
                            <button className="nj-oneline-btn" onClick={saveEditSection}>
                              저장
                            </button>
                            <button className="nj-oneline-btn muted" onClick={cancelEditSection}>
                              취소
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="nj-period-kw-row">
                          {current.keywords.map((kw) => (
                            <span className="nj-period-kw-chip" key={kw}>
                              #{kw}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                  <div className="nj-period-analysis-meta">
                    기록 {current.entryCount}건 기준 · {new Date(current.generatedAt).toLocaleString("ko-KR")}
                  </div>
                </>
              );
            }
            return (
              <div className="nj-period-analysis-body muted">
                {periodEntries.length === 0
                  ? "이 기간에 기록이 없어요."
                  : "이 기간 기록을 바탕으로 AI가 전체 흐름을 정리해줄 수 있어요."}
                {periodEntries.length > 0 && (
                  <button className="nj-oneline-btn" onClick={requestPeriodAnalysis}>
                    지금 생성하기
                  </button>
                )}
              </div>
            );
          })()}
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
                    <button
                      className="nj-chip-remove"
                      title="키워드 삭제"
                      onClick={() => removeEntryTag(e.id, t, "industry")}
                    >
                      <X size={10} />
                    </button>
                  </span>
                ))}
                {(e.stockTags || []).map((t) => (
                  <span key={"s" + t} className="nj-chip stock">
                    #{t}
                    <button
                      className="nj-chip-remove"
                      title="키워드 삭제"
                      onClick={() => removeEntryTag(e.id, t, "stock")}
                    >
                      <X size={10} />
                    </button>
                  </span>
                ))}
                {(e.techTags || []).map((t) => (
                  <span key={"h" + t} className="nj-chip tech">
                    #{t}
                    <button
                      className="nj-chip-remove"
                      title="키워드 삭제"
                      onClick={() => removeEntryTag(e.id, t, "tech")}
                    >
                      <X size={10} />
                    </button>
                  </span>
                ))}
              </div>
              <div className="nj-entry-summary">
                {parseSummaryLinesRich(e.summary).map((line, i) => (
                  <div className="nj-summary-line" key={i}>
                    <span className="nj-summary-marker" style={{ visibility: line.noMarker ? "hidden" : "visible" }} />
                    <span>{line.text}</span>
                  </div>
                ))}
              </div>
              <div className="nj-entry-ai-kw">
                <div className="nj-entry-ai-kw-head">
                  <span className="nj-entry-ai-kw-label">AI 추천 키워드</span>
                  <button
                    className={`nj-ai-refresh-btn${entryKwLoading[e.id] ? " spinning" : ""}`}
                    title="AI 키워드 추천 생성 · 새로고침"
                    onClick={() => requestEntryKeywords(e)}
                    disabled={entryKwLoading[e.id]}
                  >
                    <RefreshCw size={12} />
                  </button>
                </div>
                {entryKwLoading[e.id] ? (
                  <div className="nj-period-analysis-body muted">뉴스 링크를 읽는 중...</div>
                ) : (e.aiStockKeywords && e.aiStockKeywords.length > 0) || (e.aiTechKeywords && e.aiTechKeywords.length > 0) ? (
                  <div className="nj-ai-kw-row">
                    {(e.aiStockKeywords || []).map((kw) => (
                      <span className="nj-ai-kw-chip stock" key={"eaks" + kw}>
                        #{kw}
                        <button
                          className="nj-kw-add-btn"
                          title="종목 키워드로 추가"
                          onClick={() => addSuggestedKeyword(e.id, kw, "stock")}
                        >
                          !
                        </button>
                      </span>
                    ))}
                    {(e.aiTechKeywords || []).map((kw) => (
                      <span className="nj-ai-kw-chip tech" key={"eakt" + kw}>
                        #{kw}
                        <button
                          className="nj-kw-add-btn"
                          title="기술 키워드로 추가"
                          onClick={() => addSuggestedKeyword(e.id, kw, "tech")}
                        >
                          !
                        </button>
                      </span>
                    ))}
                  </div>
                ) : (
                  <button className="nj-oneline-btn" onClick={() => requestEntryKeywords(e)}>
                    지금 추천받기
                  </button>
                )}
              </div>
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
          onMouseDown={(e) => {
            overlayMouseDownOnBackdrop.current = e.target === e.currentTarget;
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget && overlayMouseDownOnBackdrop.current) {
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
              {(() => {
                const suggestions = getKeywordSuggestions(fIndustryInput, allIndustryTagsUsed, fIndustryTags);
                return (
                  suggestions.length > 0 && (
                    <div className="nj-kw-suggest-list">
                      {suggestions.map((s) => (
                        <button
                          key={s}
                          className="nj-kw-suggest-item industry"
                          onClick={() => addChip(s, setFIndustryInput, fIndustryTags, setFIndustryTags)}
                        >
                          #{s}
                        </button>
                      ))}
                    </div>
                  )
                );
              })()}
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
                종목
              </div>
              <div className="nj-row">
                <input
                  className="nj-input"
                  placeholder="예: SK하이닉스, 삼성전자 (엔터로 추가)"
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
              {(() => {
                const suggestions = getKeywordSuggestions(fStockInput, allStockTagsUsed, fStockTags);
                return (
                  suggestions.length > 0 && (
                    <div className="nj-kw-suggest-list">
                      {suggestions.map((s) => (
                        <button
                          key={s}
                          className="nj-kw-suggest-item stock"
                          onClick={() => addChip(s, setFStockInput, fStockTags, setFStockTags)}
                        >
                          #{s}
                        </button>
                      ))}
                    </div>
                  )
                );
              })()}
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

              <div className="nj-mini-label" style={{ marginTop: 12 }}>
                기술/제품/기타
              </div>
              <div className="nj-row">
                <input
                  className="nj-input"
                  placeholder="예: HBM4, FC-BGA (엔터로 추가)"
                  value={fTechInput}
                  onChange={(ev) => setFTechInput(ev.target.value)}
                  onKeyDown={(ev) => {
                    if (ev.key === "Enter" || ev.key === ",") {
                      ev.preventDefault();
                      addChip(fTechInput, setFTechInput, fTechTags, setFTechTags);
                    }
                  }}
                />
              </div>
              {(() => {
                const suggestions = getKeywordSuggestions(fTechInput, allTechTagsUsed, fTechTags);
                return (
                  suggestions.length > 0 && (
                    <div className="nj-kw-suggest-list">
                      {suggestions.map((s) => (
                        <button
                          key={s}
                          className="nj-kw-suggest-item tech"
                          onClick={() => addChip(s, setFTechInput, fTechTags, setFTechTags)}
                        >
                          #{s}
                        </button>
                      ))}
                    </div>
                  )
                );
              })()}
              <div className="nj-chips-input">
                {fTechTags.map((t) => (
                  <span key={t} className="nj-chip-editable tech">
                    #{t}
                    <button onClick={() => setFTechTags(fTechTags.filter((x) => x !== t))}>
                      <X size={11} />
                    </button>
                  </span>
                ))}
              </div>
            </div>

            <div className="nj-section">
              <div className="nj-section-label">3. 뉴스 요약 (직접 작성)</div>
              <div className="nj-mini-label" style={{ marginBottom: 6 }}>
                엔터를 누르면 자동으로 다음 줄이 생겨요. Alt+Enter를 누르면 그 줄의 마커가 사라져요.
              </div>
              <div className="nj-bullet-editor">
                {fSummaryLines.map((line, i) => (
                  <div className="nj-bullet-row" key={line.id}>
                    <span className="nj-summary-marker" style={{ visibility: line.noMarker ? "hidden" : "visible" }} />
                    <input
                      ref={(el) => {
                        if (el) lineInputRefs.current[line.id] = el;
                      }}
                      className="nj-bullet-input"
                      value={line.text}
                      onChange={(ev) => updateLineText(line.id, ev.target.value)}
                      onKeyDown={(ev) => handleLineKeyDown(line.id, ev)}
                      placeholder={i === 0 ? "이 뉴스를 왜 중요하다고 봤는지 적어주세요" : ""}
                    />
                  </div>
                ))}
              </div>
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
