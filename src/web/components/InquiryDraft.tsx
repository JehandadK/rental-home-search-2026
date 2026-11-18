/**
 * A ready-to-send Japanese inquiry for one home, with an English gloss.
 * Closed by default and builds nothing until opened, because every expanded
 * table row renders one. The "About you" answers are typed once and reused
 * for every home; which questions to ask is per draft and not saved.
 */
import { useId, useMemo, useState } from "react";
import {
  DEFAULT_INQUIRY_QUESTIONS,
  buildInquiry,
  decodeInquiryProfile,
  type InquiryProfile,
  type InquiryQuestions,
  type JapaneseLevel,
} from "../../domain/inquiry";
import { sourceListings } from "../../domain/listingDedup";
import { isUrListing } from "../../domain/ur";
import type { EnrichedListing } from "../../domain/types";
import { USER_STATE_KEYS } from "../userState/store";
import { usePersistentState } from "../userState/UserStateContext";
import styles from "./InquiryDraft.module.css";

export interface InquiryDraftProps {
  listing: EnrichedListing;
  /** The viewing booked in the user's note for this home, if any. */
  viewingAt?: string | null;
}

const QUESTION_LABELS: [keyof InquiryQuestions, string][] = [
  ["availability", "Still available?"],
  ["foreignTenant", "Accepts a foreign tenant?"],
  ["viewing", "Viewing"],
  ["initialCosts", "Move-in costs"],
  ["parking", "Parking"],
  ["moveInDate", "Move-in date"],
];

type CopyState = "idle" | "copied-all" | "copied-body" | "failed";

export function InquiryDraft({ listing, viewingAt = null }: InquiryDraftProps) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [questions, setQuestions] = useState<InquiryQuestions>(DEFAULT_INQUIRY_QUESTIONS);
  const [profile, setProfile] = usePersistentState<InquiryProfile>(USER_STATE_KEYS.inquiryProfile, decodeInquiryProfile);
  const [copy, setCopy] = useState<CopyState>("idle");
  const ur = isUrListing(listing);

  const draft = useMemo(
    () => (open ? buildInquiry(listing, profile, questions, viewingAt) : null),
    [open, listing, profile, questions, viewingAt],
  );
  const adUrl = listing.url ?? sourceListings(listing).find((ad) => ad.url)?.url ?? null;

  const setField = <K extends keyof InquiryProfile>(key: K, value: InquiryProfile[K]) => setProfile((p) => ({ ...p, [key]: value }));
  const setCount = (key: "adults" | "children", raw: string) => {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n)) setProfile(decodeInquiryProfile({ ...profile, [key]: n }));
  };

  const copyText = async (text: string, done: CopyState) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopy(done);
      setTimeout(() => setCopy("idle"), 2000);
    } catch {
      setCopy("failed");
    }
  };

  return (
    <details className={styles.inquiry} open={open} onClick={(e) => e.stopPropagation()}>
      {/* Toggled by hand so the open state is React's, not the browser's: nothing is built until it is true. */}
      <summary
        className={styles.summary}
        onClick={(e) => {
          e.preventDefault();
          setOpen((o) => !o);
        }}
      >✉ Inquiry draft (日本語)</summary>
      {draft && (
        <div className={styles.content}>
          <fieldset className={styles.questions}>
            <legend>Ask about</legend>
            {QUESTION_LABELS.filter(([key]) => !(ur && key === "foreignTenant")).map(([key, label]) => (
              <label key={key}>
                <input
                  type="checkbox"
                  checked={questions[key]}
                  onChange={(e) => setQuestions((q) => ({ ...q, [key]: e.target.checked }))}
                />
                {label}
              </label>
            ))}
          </fieldset>

          <details className={styles.about}>
            <summary>About you</summary>
            <div className={styles.form}>
              <label>
                Name
                <input value={profile.name} onChange={(e) => setField("name", e.target.value)} autoComplete="off" />
              </label>
              <label>
                Nationality
                <input value={profile.nationality} placeholder="パキスタン" onChange={(e) => setField("nationality", e.target.value)} />
              </label>
              <label>
                Residence status
                <input
                  value={profile.residenceStatus}
                  placeholder="永住者"
                  onChange={(e) => setField("residenceStatus", e.target.value)}
                />
              </label>
              <label>
                Japanese
                <select value={profile.japanese} onChange={(e) => setField("japanese", e.target.value as JapaneseLevel)}>
                  <option value="fluent">Fluent</option>
                  <option value="daily">Everyday conversation</option>
                  <option value="english-preferred">English preferred</option>
                </select>
              </label>
              <label>
                Adults
                <input type="number" min={1} max={9} value={profile.adults} onChange={(e) => setCount("adults", e.target.value)} />
              </label>
              <label>
                Children
                <input type="number" min={0} max={9} value={profile.children} onChange={(e) => setCount("children", e.target.value)} />
              </label>
              <label>
                Move-in
                <input value={profile.moveIn} placeholder="2027-03" onChange={(e) => setField("moveIn", e.target.value)} />
              </label>
              <label>
                Phone or e-mail
                <input value={profile.contact} onChange={(e) => setField("contact", e.target.value)} autoComplete="off" />
              </label>
            </div>
          </details>

          <div className={styles.texts}>
            <div className={styles.japanese} lang="ja" id={`${id}-ja`} aria-label="Japanese message">
              <strong>{draft.subject}</strong>
              {"\n\n"}
              {draft.body}
            </div>
            <div className={styles.english} lang="en" aria-label="English gloss">
              {draft.english}
            </div>
          </div>

          <div className={styles.actions}>
            <button type="button" onClick={() => copyText(`${draft.subject}\n\n${draft.body}`, "copied-all")}>
              {copy === "copied-all" ? "Copied ✓" : "Copy Japanese"}
            </button>
            <button type="button" className="secondary" onClick={() => copyText(draft.body, "copied-body")}>
              {copy === "copied-body" ? "Copied ✓" : "Copy body only"}
            </button>
            {adUrl && (
              <a href={adUrl} target="_blank" rel="noreferrer">
                Open the ad ↗
              </a>
            )}
            {copy === "failed" && <span className={styles.warn}>Copy is not available here. Select the text and copy it.</span>}
          </div>
          <p className={styles.note}>Sent by you, from your own mail or the portal&apos;s form. Nothing leaves this page.</p>
        </div>
      )}
    </details>
  );
}
