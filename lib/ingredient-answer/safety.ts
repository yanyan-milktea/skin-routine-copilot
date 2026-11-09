import type { Classification } from "../ingredient-retrieval.ts";
import type { CareCode, LimitationCode } from "./contract.ts";

// Deterministic safety rules shared by the handler and tests (design Sections
// 2.5, 7.4-7.6). Audited phrase sets; no model judgement.

const URGENT = /\b(swell(?:ing|s|ed)?|swollen|blister(?:s|ing|ed)?|ooz(?:e|es|ing)|(?:can ?not|can't|cannot|trouble|difficulty)\s+breath(?:e|ing)|short(?:ness)? of breath|anaphyla\w*|throat (?:closing|tight\w*)|eye (?:swelling|pain|burn\w*)|in my eyes?|severe pain|rapidly (?:worsening|spreading)|spreading fast|emergency)\b/i;
const PREGNANCY = /\b(pregnan\w*|breast ?feeding|nursing|lactat\w*|trying to conceive|expecting a baby)\b/i;
const REACTION_OR_CONDITION = /\b(rash|hives|allerg\w*|reaction|burn(?:s|ing)?|sting(?:s|ing)? (?:that )?(?:won't|will not|doesn't|does not) stop|persistent (?:burning|stinging)|eczema|rosacea|psoriasis|dermatitis|acne (?:treatment|medication)|diagnos\w*|prescri\w*|my (?:doctor|dermatologist)'?s? (?:plan|prescription)|instead of (?:my|the) (?:doctor|dermatologist))\b/i;

/** Care escalation from the raw (bounded) question. Urgent wins, then pregnancy, then reaction/condition. */
export function careCodeForQuestion(question: string): CareCode | null {
  if (URGENT.test(question)) return "URGENT_LOCAL_CARE";
  if (PREGNANCY.test(question)) return "PREGNANCY_CLINICIAN";
  if (REACTION_OR_CONDITION.test(question)) return "CONSULT_DERMATOLOGIST";
  return null;
}

/** Deterministic limitation for a question that cannot be answered, from the classifier outcome. */
export function limitationForClassification(classification: Pick<Classification, "status" | "blocked_families">): LimitationCode | null {
  if (classification.status === "blocked") {
    if (classification.blocked_families.includes("pairwise_compatibility")) return "PAIRWISE_COMPATIBILITY_UNSUPPORTED";
    if (classification.blocked_families.includes("product_composition")) return "PRODUCT_SPECIFIC_UNSUPPORTED";
    return "OUT_OF_SCOPE";
  }
  if (classification.status === "unclassified" || classification.status === "ambiguous" || classification.status === "invalid") return "OUT_OF_SCOPE";
  return null;
}

// --- Claim-unit policy gate (Section 7.2 gate 10, 7.4, 7.5, 7.6) -------------

const NEGATED_APPROVAL = /\b(?:not|no|never|without|n't)\b[^.]{0,40}\b(?:approv\w*|pre-?clear\w*)\b|\b(?:approv\w*)\b[^.]{0,20}\b(?:is not|are not|isn't|aren't) required\b/i;
const AFFIRMED_APPROVAL = /\b(?:is|are|was|were|been|being|gets?|got)\s+(?:\w+\s+){0,2}(?:fda[- ]?)?approved\b|\bfda[- ]approved\b/i;
const COLOR_ADDITIVE = /\bcolou?r additives?\b/i;

/** "FDA approved" guardrail: an ordinary cosmetic/ingredient may not be presented as approved. Color additives are the reviewed exception. */
export function isUnsupportedRegulatoryClaim(text: string): boolean {
  if (!AFFIRMED_APPROVAL.test(text)) return false;
  if (COLOR_ADDITIVE.test(text)) return false;
  return !NEGATED_APPROVAL.test(text);
}

const COMPATIBILITY = /\b(?:safe|fine|okay|ok|compatible|incompatible)\s+(?:to\s+)?(?:use|combine|mix|layer|pair)\w*\s+(?:\w+\s+){0,4}(?:with|together|alongside)\b|\b(?:can|should|may)\s+(?:be\s+)?(?:combined|mixed|layered|paired|used together)\b|\b(?:do not|don't|never)\s+(?:combine|mix|layer)\b/i;

/** Pairwise-compatibility assertions are not supported by the Phase 1 corpus. */
export function isCompatibilityClaim(text: string): boolean {
  return COMPATIBILITY.test(text);
}

const DIAGNOSTIC = /\b(?:you have|you(?:'re| are) (?:allergic|suffering)|this is (?:an? )?(?:allerg\w*|rash|infection|condition|eczema|rosacea|acne)|(?:will|is guaranteed to) (?:cure|treat|fix|clear)|(?:take|apply|use) \d+(?:\.\d+)?\s?(?:mg|ml|%|percent)\b.*\b(?:daily|twice|times)|stop (?:taking|using) your (?:medication|prescription)|safe for (?:you|your baby)|will work for you)\b/i;

/** Non-diagnostic enforcement on any text that could reach the user. */
export function isDiagnosticClaim(text: string): boolean {
  return DIAGNOSTIC.test(text);
}

/** Policy rule codes for one canonical claim text; empty means it may be shown. */
export function claimPolicyFailures(text: string): string[] {
  const failures: string[] = [];
  if (isUnsupportedRegulatoryClaim(text)) failures.push("UNSUPPORTED_REGULATORY_CLAIM");
  if (isCompatibilityClaim(text)) failures.push("UNSUPPORTED_COMPATIBILITY_CLAIM");
  if (isDiagnosticClaim(text)) failures.push("DIAGNOSTIC_CLAIM");
  return failures;
}
