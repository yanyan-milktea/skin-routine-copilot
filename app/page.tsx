"use client";

import { useEffect, useMemo, useState } from "react";
import {
  addHistoryEntry,
  createEmptyHistoryStore,
  generateFallbackTrendSummary,
  guardTrendSummary,
  HISTORY_SCHEMA_VERSION,
  HISTORY_STORAGE_KEY,
  HistoryEntry,
  parseHistoryStore,
  recentHistory,
  TrendSummary,
  TrendSummaryResponse,
} from "../lib/history";
import { Concern, enforceGuardrails, generateFallbackPlan, normalizePlanToEnglish, RoutinePlan, RoutineResponse } from "../lib/routine";

// Leave NEXT_PUBLIC_AI_API_URL empty in .env.local to use this repo's local API route.
// The default keeps the deployed Sites frontend connected to the production proxy.
const AI_API_URL = process.env.NEXT_PUBLIC_AI_API_URL
  ?? "https://skin-routine-ai-api-imyanchen-3068-imyanchen-3068s-projects.vercel.app";

const concerns: { id: Concern; emoji: string; label: string }[] = [
  { id: "breakouts", emoji: "◌", label: "Breakouts" },
  { id: "oily", emoji: "◇", label: "Oiliness" },
  { id: "sensitive", emoji: "≈", label: "Sensitivity" },
  { id: "redness", emoji: "○", label: "Redness" },
  { id: "dry", emoji: "⌁", label: "Dryness" },
  { id: "dull", emoji: "✦", label: "Dullness" },
];

const products = [
  { name: "beplain Mung Bean Cleanser", kind: "Cleanser", color: "mint" },
  { name: "Micro Essence", kind: "Essence", color: "peach" },
  { name: "Torriden Dive-In", kind: "Hydrating serum", color: "blue" },
  { name: "Azelaic Acid 10%", kind: "Active treatment", color: "cream" },
  { name: "Lancôme Youth Activating Cream", kind: "Moisturizer", color: "rose" },
  { name: "EltaMD UV Clear", kind: "Sunscreen", color: "sand" },
];

export default function Home() {
  const [selected, setSelected] = useState<Concern[]>(["breakouts", "oily"]);
  const [sleep, setSleep] = useState(3);
  const [notes, setNotes] = useState("");
  const [tab, setTab] = useState<"morning" | "evening">("morning");
  const [generated, setGenerated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [showShelf, setShowShelf] = useState(false);
  const [generatedPlan, setGeneratedPlan] = useState<RoutinePlan | null>(null);
  const [engine, setEngine] = useState<RoutineResponse["meta"] | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [historyReady, setHistoryReady] = useState(false);
  const [trendSummary, setTrendSummary] = useState<TrendSummary | null>(null);
  const [trendEngine, setTrendEngine] = useState<TrendSummaryResponse["meta"] | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);

  const localRoutine = useMemo(() => generateFallbackPlan(selected, sleep, notes), [selected, sleep, notes]);
  const routine = generatedPlan ?? localRoutine;
  const steps = tab === "morning" ? routine.morning : routine.evening;
  const visibleHistory = useMemo(() => recentHistory(history), [history]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      setHistory(parseHistoryStore(window.localStorage.getItem(HISTORY_STORAGE_KEY)).entries);
      setHistoryReady(true);
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    if (!historyReady) return;
    window.localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify({ version: HISTORY_SCHEMA_VERSION, entries: history }));
  }, [history, historyReady]);

  function toggleConcern(id: Concern) {
    setSelected((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
    setGenerated(false);
    setGeneratedPlan(null);
  }

  async function generate() {
    setLoading(true);
    let completedPlan = localRoutine;
    let completedMeta: RoutineResponse["meta"] = { source: "fallback", provider: null, model: null, latency_ms: 0, reason: "network_error" };
    try {
      const response = await fetch(`${AI_API_URL}/api/generate-routine`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ concerns: selected, sleep, notes }),
      });
      if (!response.ok) throw new Error("Routine request failed");
      const result = await response.json() as RoutineResponse;
      const englishPlan = normalizePlanToEnglish(result.plan, selected, sleep, notes);
      completedPlan = enforceGuardrails(englishPlan, selected, notes);
      completedMeta = result.meta;
    } catch {
      completedPlan = localRoutine;
    } finally {
      setGeneratedPlan(completedPlan);
      setEngine(completedMeta);
      const entry: HistoryEntry = {
        id: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        created_at: new Date().toISOString(),
        concerns: selected,
        sleep,
        notes: notes.trim().slice(0, 500),
        plan: completedPlan,
        meta: completedMeta,
      };
      setHistory((current) => addHistoryEntry(current, entry));
      setTrendSummary(null);
      setTrendEngine(null);
      setLoading(false);
      setGenerated(true);
      window.setTimeout(() => document.getElementById("plan")?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
    }
  }

  async function summarizeHistory() {
    if (visibleHistory.length === 0) return;
    setSummaryLoading(true);
    try {
      const response = await fetch(`${AI_API_URL}/api/summarize-history`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entries: visibleHistory }),
      });
      if (!response.ok) throw new Error("Trend summary request failed");
      const result = await response.json() as TrendSummaryResponse;
      setTrendSummary(guardTrendSummary(result.summary, visibleHistory));
      setTrendEngine(result.meta);
    } catch {
      setTrendSummary(generateFallbackTrendSummary(visibleHistory));
      setTrendEngine({ source: "fallback", provider: null, model: null, latency_ms: 0, reason: "network_error" });
    } finally {
      setSummaryLoading(false);
    }
  }

  function deleteHistoryEntry(id: string) {
    setHistory((current) => current.filter((entry) => entry.id !== id));
    setTrendSummary(null);
    setTrendEngine(null);
  }

  function clearHistory() {
    if (!window.confirm("Clear all history stored in this browser?")) return;
    setHistory(createEmptyHistoryStore().entries);
    setTrendSummary(null);
    setTrendEngine(null);
  }

  const today = new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", weekday: "short" }).format(new Date());

  return (
    <main>
      <nav className="nav shell">
        <a className="brand" href="#top" aria-label="Skin Routine Copilot home">
          <span className="brand-mark">s</span>
          <span>skin routine</span>
        </a>
        <div className="nav-actions">
          <span className="prototype-pill"><i /> Gemini AI · live</span>
          <button className="avatar" onClick={() => setShowShelf(!showShelf)} aria-label="Open my product shelf">YC</button>
        </div>
      </nav>

      <section className="hero shell" id="top">
        <div className="eyebrow">YOUR DAILY SKIN CHECK-IN</div>
        <h1>What is your skin <em>telling you today?</em></h1>
        <p className="hero-copy">Take one minute to check in. Copilot will build a simple, gentle routine using only products you already own.</p>
        <div className="date-line" suppressHydrationWarning><span /> {today}<span /></div>
      </section>

      <section className="workspace shell">
        <div className="checkin-card">
          <div className="card-heading">
            <div><span className="step-kicker">STEP 01</span><h2>Quick check-in</h2></div>
            <span className="autosave">✓ Auto-saved</span>
          </div>

          <label className="field-label">What is your skin showing today? <span>Select all that apply</span></label>
          <div className="concern-grid">
            {concerns.map((item) => (
              <button key={item.id} onClick={() => toggleConcern(item.id)} className={`concern ${selected.includes(item.id) ? "active" : ""}`} aria-pressed={selected.includes(item.id)}>
                <b>{item.emoji}</b><span>{item.label}</span><i>{selected.includes(item.id) ? "✓" : "+"}</i>
              </button>
            ))}
          </div>

          <div className="sleep-field">
            <div><label className="field-label">How did you sleep last night?</label><p>Sleep can affect how your skin behaves today</p></div>
            <div className="sleep-scale" aria-label="Sleep rating">
              {[1, 2, 3, 4, 5].map((score) => <button key={score} onClick={() => { setSleep(score); setGenerated(false); setGeneratedPlan(null); }} className={sleep === score ? "active" : ""}>{score}</button>)}
            </div>
          </div>

          <label className="field-label notes-label" htmlFor="notes">Anything else to note? <span>Optional</span></label>
          <textarea id="notes" value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="For example: a tender spot on my chin and some dryness around my nose…" />

          <button className="generate" onClick={generate} disabled={loading}>
            <span>{loading ? "Reading today’s signals…" : "Build today’s routine"}</span>
            <b>{loading ? "···" : "→"}</b>
          </button>
          <p className="microcopy">Built from your shelf · Do not enter names or medical records · Not a substitute for professional care</p>
        </div>

        <aside className={`shelf-card ${showShelf ? "open" : ""}`}>
          <div className="shelf-heading"><div><span className="step-kicker">MY SHELF</span><h2>My products</h2></div><button aria-label="Add a product">+</button></div>
          <p>Copilot only plans with products already on your shelf.</p>
          <div className="product-list">
            {products.map((product) => <div className="product" key={product.name}><span className={`product-icon ${product.color}`} /><div><b>{product.name}</b><small>{product.kind}</small></div><i>•••</i></div>)}
          </div>
          <button className="manage">Manage all products <span>→</span></button>
        </aside>
      </section>

      <section className={`plan-section ${generated ? "revealed" : ""}`} id="plan" aria-live="polite">
        <div className="shell plan-shell">
          {!generated ? (
            <div className="empty-plan"><span>✦</span><p>Your routine will appear here after your check-in.</p></div>
          ) : (
            <>
              <div className="plan-intro">
                <div><span className="step-kicker">TODAY’S ROUTINE</span><h2>Less can be more today.</h2></div>
                <div className="priority"><small>Today’s focus</small><b>{routine.priority}</b></div>
              </div>
              <div className="insight"><span>✦</span><div><div className="insight-title"><b>Copilot’s take</b>{engine && <small className={`engine-badge ${engine.source}`}>{engine.source === "ai" ? `${engine.provider === "gemini" ? "Gemini" : "OpenAI"} Structured AI · ${engine.latency_ms}ms` : "Safety engine · fallback"}</small>}</div><p>{routine.note}</p>{routine.warnings.length > 0 && <p className="warning-copy">{routine.warnings.join(" ")}</p>}</div></div>
              <div className="routine-card">
                <div className="tabs" role="tablist">
                  <button role="tab" aria-selected={tab === "morning"} className={tab === "morning" ? "active" : ""} onClick={() => setTab("morning")}><span>☀</span> Morning <small>{routine.morning.length} steps</small></button>
                  <button role="tab" aria-selected={tab === "evening"} className={tab === "evening" ? "active" : ""} onClick={() => setTab("evening")}><span>☾</span> Evening <small>{routine.evening.length} steps</small></button>
                </div>
                <div className="steps">
                  {steps.map((step) => <article className="routine-step" key={`${tab}-${step.time}`}><span className="step-number">{step.time}</span><div><div className="step-title"><h3>{step.name}</h3>{step.tag && <small>{step.tag}</small>}</div><p>{step.detail}</p></div><button aria-label={`Mark ${step.name} complete`}>○</button></article>)}
                </div>
              </div>
              <p className="plan-footnote">If stinging persists, swelling appears, or a rash worsens, stop the relevant products and seek professional care.</p>
            </>
          )}
        </div>
      </section>

      <section className="history-section" id="history">
        <div className="shell history-shell">
          <div className="history-heading">
            <div><span className="step-kicker">YOUR RECENT PATTERNS</span><h2>History</h2></div>
            <div className="history-actions">
              <button className="summary-button" onClick={summarizeHistory} disabled={summaryLoading || visibleHistory.length === 0}>
                {summaryLoading ? "Reading the week…" : "Summarize my week"}<span>✦</span>
              </button>
              {history.length > 0 && <button className="clear-history" onClick={clearHistory}>Clear history</button>}
            </div>
          </div>
          <p className="history-privacy"><span>⌂</span><b>Private to this browser.</b> Your latest 30 check-ins are stored only in localStorage on this device. No API keys or secrets are stored.</p>

          {trendSummary && (
            <article className="trend-card" aria-live="polite">
              <div className="trend-topline"><span>WEEKLY TREND SUMMARY</span>{trendEngine && <small className={`engine-badge ${trendEngine.source}`}>{trendEngine.source === "ai" ? "Gemini Structured AI" : "Deterministic fallback"}</small>}</div>
              <h3>{trendSummary.headline}</h3>
              <p>{trendSummary.overview}</p>
              <div className="trend-columns">
                <div><b>Patterns noticed</b><ul>{trendSummary.patterns.map((pattern) => <li key={pattern}>{pattern}</li>)}</ul></div>
                <div><b>Gentle next steps</b><ul>{trendSummary.gentle_next_steps.map((step) => <li key={step}>{step}</li>)}</ul></div>
              </div>
              <small className="trend-disclaimer">{trendSummary.disclaimer}</small>
            </article>
          )}

          <div className="history-list" aria-live="polite">
            {visibleHistory.length === 0 ? (
              <div className="empty-history"><span>○</span><div><b>No saved check-ins yet</b><p>Generate a routine to start a private, browser-only history.</p></div></div>
            ) : visibleHistory.map((entry) => (
              <article className="history-item" key={entry.id}>
                <div className="history-date"><b>{new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(new Date(entry.created_at))}</b><small>{new Intl.DateTimeFormat("en-US", { weekday: "short" }).format(new Date(entry.created_at))}</small></div>
                <div className="history-content">
                  <div className="signal-tags">{entry.concerns.length > 0 ? entry.concerns.map((concern) => <span key={concern}>{concerns.find((item) => item.id === concern)?.label ?? concern}</span>) : <span>No signal selected</span>}</div>
                  <b>{entry.plan.priority}</b>
                  <small>Sleep {entry.sleep}/5</small>
                </div>
                <div className="history-source"><span className={entry.meta.source}>{entry.meta.source === "ai" && entry.meta.provider === "gemini" ? "Gemini" : entry.meta.source === "ai" ? "AI" : "Fallback"}</span><button onClick={() => deleteHistoryEntry(entry.id)} aria-label={`Delete history entry from ${new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric" }).format(new Date(entry.created_at))}`}>Delete entry</button></div>
              </article>
            ))}
          </div>
          {history.length > visibleHistory.length && <p className="history-limit-note">Showing the 7 most recent check-ins. Up to 30 are retained in this browser.</p>}
        </div>
      </section>
    </main>
  );
}
