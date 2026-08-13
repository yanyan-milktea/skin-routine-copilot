"use client";

import { useMemo, useState } from "react";
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

  const localRoutine = useMemo(() => generateFallbackPlan(selected, sleep, notes), [selected, sleep, notes]);
  const routine = generatedPlan ?? localRoutine;
  const steps = tab === "morning" ? routine.morning : routine.evening;

  function toggleConcern(id: Concern) {
    setSelected((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
    setGenerated(false);
    setGeneratedPlan(null);
  }

  async function generate() {
    setLoading(true);
    try {
      const response = await fetch(`${AI_API_URL}/api/generate-routine`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ concerns: selected, sleep, notes }),
      });
      if (!response.ok) throw new Error("Routine request failed");
      const result = await response.json() as RoutineResponse;
      const englishPlan = normalizePlanToEnglish(result.plan, selected, sleep, notes);
      setGeneratedPlan(enforceGuardrails(englishPlan, selected, notes));
      setEngine(result.meta);
    } catch {
      setGeneratedPlan(localRoutine);
      setEngine({ source: "fallback", provider: null, model: null, latency_ms: 0, reason: "network_error" });
    } finally {
      setLoading(false);
      setGenerated(true);
      window.setTimeout(() => document.getElementById("plan")?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
    }
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
    </main>
  );
}
