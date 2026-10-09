/**
 * Sidebar panel for tuning the scoring scheme: per-parameter weights,
 * the normalisation anchors (what counts as "full score" vs "zero"),
 * and global options. Rendered data-driven from SCORE_PARAMETERS so a
 * new parameter only needs one entry in domain/scoringConfig.ts.
 */
import { useState } from "react";
import { FEATURE_PARAMETERS, SCORE_PARAMETERS, type ScoringConfig } from "../../domain/scoringConfig";
import { matchesPreset, type WeightPreset } from "../../domain/weightPresets";
import type { ParameterDiagnosis } from "../../domain/diagnostics";
import type { ListingAttributeCategory, ListingFeatureKey, ScoreParameterKey } from "../../domain/types";
import { ATTRIBUTE_CATEGORY_LABELS } from "../../domain/listingAttributes";
import styles from "./WeightPanel.module.css";
import appStyles from "../App.module.css";

interface Props {
  config: ScoringConfig;
  onSetWeight: (key: ScoreParameterKey, weight: number) => void;
  onSetFeatureWeight: (key: ListingFeatureKey, weight: number) => void;
  onSetFeaturePreference: (key: ListingFeatureKey, preference: "prefer" | "avoid") => void;
  onUpdate: (patch: Partial<ScoringConfig>) => void;
  onSetWalkZero: (key: keyof ScoringConfig["walkZeroMinutes"], minutes: number) => void;
  onZeroAllWeights: () => void;
  onReset: () => void;
  onExportCsv: () => void;
  onExportMarkdown: () => void;
  /** Parameters that currently fail to discriminate, keyed for lookup. */
  diagnoses: ParameterDiagnosis[];
  /** Apply a data-fitted anchor for one parameter. */
  onFitAnchor: (key: ScoreParameterKey, suggested: number) => void;
  /** Apply data-fitted anchors for every flagged parameter at once. */
  onFitAll: () => void;
  /** Built-in and saved weight presets; omitted, the presets row is hidden. */
  presets?: readonly WeightPreset[];
  onApplyPreset?: (preset: WeightPreset) => void;
  /** Save the current weights under a name. */
  onSavePreset?: (label: string) => void;
  onDeletePreset?: (id: string) => void;
}

/** Parameters measured in walking minutes get a "zero at N min" anchor. */
const WALK_PARAMETERS = new Set<ScoreParameterKey>([
  "poi1", "poi2", "station", "busStop", "kindergarten", "school",
]);

const FEATURE_CATEGORIES: ListingAttributeCategory[] = [
  "parking", "bathroom", "comfort", "kitchen", "connectivity",
  "security", "storage", "building", "tenancy",
];

const asNumber = (raw: string, fallback: number) => {
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
};

const clampPercent = (n: number) => Math.min(100, Math.max(0, n));

/** Unit shown next to a suggested anchor. */
const anchorUnit = (key: ScoreParameterKey) => {
  if (key === "rent") return "¥";
  if (key === "rentPerM2") return " ¥/㎡";
  if (key === "size") return "㎡";
  if (key === "yearBuilt") return " yrs";
  return " min";
};

export function WeightPanel(props: Props) {
  const { config, diagnoses } = props;
  const diagnosisOf = (key: ScoreParameterKey) => diagnoses.find((d) => d.key === key);
  const fixable = diagnoses.filter((d) => d.suggestedAnchor != null);

  return (
    <section className={appStyles.card}>
      <h2 className={appStyles.cardTitle}>
        Scoring preferences{" "}
        <span className={styles.headingActions}>
          <button
            className={`secondary ${styles.zeroAll}`}
            onClick={props.onZeroAllWeights}
            title="Set every numeric and property-feature weight to zero"
          >
            zero all
          </button>
          <button className={`secondary ${styles.reset}`} onClick={props.onReset}>
            reset defaults
          </button>
        </span>
      </h2>

      {props.presets && props.onApplyPreset && (
        <PresetRow
          config={config}
          presets={props.presets}
          onApply={props.onApplyPreset}
          onSave={props.onSavePreset}
          onDelete={props.onDeletePreset}
        />
      )}

      <p className={styles.featureIntro}>
        Set any weight to 0–20. Property features are available below the numeric criteria.
      </p>

      {/* Travel mode: walking vs cycling changes which homes are truly close. */}
      <div className={styles.modeRow}>
        <span className={styles.modeLabel}>Travel by</span>
        <div className={styles.modeToggle}>
          <button
            className={config.travelMode === "walk" ? styles.on : ""}
            onClick={() => props.onUpdate({ travelMode: "walk" })}
            title="Score distances at walking speed"
          >
            🚶 Walk
          </button>
          <button
            className={config.travelMode === "bicycle" ? styles.on : ""}
            onClick={() => props.onUpdate({ travelMode: "bicycle" })}
            title="Score distances at cycling speed (ママチャリ)"
          >
            🚲 Bicycle
          </button>
        </div>
      </div>

      {fixable.length > 0 && (
        <div className={styles.alert}>
          <strong>⚠ {fixable.length} criteria decide nothing</strong>
          <p>
            Their anchors sit outside the data range, so they consume weight without
            separating any listings.
          </p>
          <button className={styles.fitAll} onClick={props.onFitAll}>
            Fit anchors to data
          </button>
        </div>
      )}

      {SCORE_PARAMETERS.map((meta) => (
        <details key={meta.key} className={styles.row}>
          <summary>
            <span className={styles.label} title={meta.description}>
              {meta.label}
              {diagnosisOf(meta.key) && (
                <span className={styles.warn} title={diagnosisOf(meta.key)!.message}>
                  ⚠
                </span>
              )}
            </span>
            <input
              type="number"
              min={0}
              max={20}
              value={config.weights[meta.key]}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => props.onSetWeight(meta.key, asNumber(e.target.value, 0))}
            />
          </summary>
          <div className={styles.anchors}>
            {diagnosisOf(meta.key) && (
              <div className={styles.diagnosis}>
                {diagnosisOf(meta.key)!.message}
                {diagnosisOf(meta.key)!.suggestedAnchor != null && (
                  <button
                    className={styles.fit}
                    onClick={() =>
                      props.onFitAnchor(meta.key, diagnosisOf(meta.key)!.suggestedAnchor!)
                    }
                  >
                    Fit to data ({diagnosisOf(meta.key)!.suggestedAnchor}
                    {anchorUnit(meta.key)})
                  </button>
                )}
              </div>
            )}
            {meta.key === "rent" && (
              <>
                <Anchor label="100 ≤ ¥" value={config.rentFullScoreBelow}
                  onChange={(v) => props.onUpdate({ rentFullScoreBelow: v })} />
                <Anchor label="0 ≥ ¥" value={config.rentZeroScoreAbove}
                  onChange={(v) => props.onUpdate({ rentZeroScoreAbove: v })} />
              </>
            )}
            {meta.key === "rentPerM2" && (
              <>
                <Anchor label="100 ≤ ¥/㎡" value={config.rentPerM2FullScoreBelow}
                  onChange={(v) => props.onUpdate({ rentPerM2FullScoreBelow: v })} />
                <Anchor label="0 ≥ ¥/㎡" value={config.rentPerM2ZeroScoreAbove}
                  onChange={(v) => props.onUpdate({ rentPerM2ZeroScoreAbove: v })} />
                <span className={styles.note}>
                  Rent including management fee divided by exclusive-use area.
                  Monthly parking is also included when “Add parking to rent” is enabled.
                </span>
              </>
            )}
            {meta.key === "moveInCost" && (
              <>
                <Anchor label="100 ≤ mo" value={config.moveInFullScoreBelowMonths}
                  onChange={(v) => props.onUpdate({ moveInFullScoreBelowMonths: v })} />
                <Anchor label="0 ≥ mo" value={config.moveInZeroScoreAboveMonths}
                  onChange={(v) => props.onUpdate({ moveInZeroScoreAboveMonths: v })} />
                <span className={styles.note}>
                  Scored on <strong>sunk</strong> cost — 礼金, agency, guarantor,
                  insurance and cleaning never come back, and{" "}
                  {Math.round(config.moveIn.depositLossRate * 100)}% of the 敷金 is
                  assumed lost to 原状回復.
                </span>
                <Anchor
                  label="敷金 lost %"
                  value={Math.round(config.moveIn.depositLossRate * 100)}
                  onChange={(v) =>
                    props.onUpdate({
                      moveIn: { ...config.moveIn, depositLossRate: clampPercent(v) / 100 },
                    })
                  }
                />
                <Anchor
                  label="Clean ¥/㎡"
                  value={config.moveIn.cleaningFeePerM2}
                  onChange={(v) =>
                    props.onUpdate({ moveIn: { ...config.moveIn, cleaningFeePerM2: v } })
                  }
                />
                <Anchor
                  label="Agency mo"
                  value={config.moveIn.agencyFeeMonths}
                  onChange={(v) =>
                    props.onUpdate({ moveIn: { ...config.moveIn, agencyFeeMonths: v } })
                  }
                />
              </>
            )}
            {meta.key === "size" && (
              <>
                <Anchor label="100 ≥ ㎡" value={config.sizeFullScoreAbove}
                  onChange={(v) => props.onUpdate({ sizeFullScoreAbove: v })} />
                <Anchor label="0 ≤ ㎡" value={config.sizeZeroScoreBelow}
                  onChange={(v) => props.onUpdate({ sizeZeroScoreBelow: v })} />
              </>
            )}
            {meta.key === "yearBuilt" && (
              <Anchor label="0 at age" value={config.buildingAgeZeroAt}
                onChange={(v) => props.onUpdate({ buildingAgeZeroAt: v })} />
            )}
            {WALK_PARAMETERS.has(meta.key) && (
              <Anchor
                label="0 at min"
                value={config.walkZeroMinutes[meta.key as keyof ScoringConfig["walkZeroMinutes"]]}
                onChange={(v) =>
                  props.onSetWalkZero(meta.key as keyof ScoringConfig["walkZeroMinutes"], v)
                }
              />
            )}
          </div>
        </details>
      ))}

      <details className={styles.featureSection} open>
        <summary>
          <strong>Property features &amp; lease terms</strong>
          <span>{Object.values(config.featureWeights).filter((weight) => weight > 0).length} active</span>
        </summary>
        <p className={styles.featureIntro}>
          Every captured qualitative feature is stored. Choose any features to score;
          weight 0 means “show it, but do not score it.” Unknown values are ignored,
          never treated as No.
        </p>
        {FEATURE_CATEGORIES.map((category) => {
          const categoryMeta = ATTRIBUTE_CATEGORY_LABELS[category];
          const features = FEATURE_PARAMETERS.filter((feature) => feature.category === category);
          if (!features.length) return null;
          return (
            <div className={styles.featureGroup} key={category}>
              <h3>{categoryMeta.en} <small>{categoryMeta.ja}</small></h3>
              {features.map((feature) => (
                <div className={styles.featureRow} key={feature.key} title={feature.description}>
                  <span>{feature.label}<small>{feature.labelJa}</small></span>
                  <select
                    aria-label={`${feature.label} preference`}
                    value={config.featurePreferences[feature.key]}
                    onChange={(event) => props.onSetFeaturePreference(
                      feature.key,
                      event.target.value as "prefer" | "avoid",
                    )}
                  >
                    <option value="prefer">Prefer yes</option>
                    <option value="avoid">Prefer no</option>
                  </select>
                  <label>
                    w
                    <input
                      type="number"
                      min={0}
                      max={20}
                      value={config.featureWeights[feature.key]}
                      onChange={(event) => props.onSetFeatureWeight(
                        feature.key,
                        asNumber(event.target.value, 0),
                      )}
                    />
                  </label>
                </div>
              ))}
            </div>
          );
        })}
      </details>

      <div className={styles.options}>
        <label>
          Include 保育園 (daycare)
          <input
            type="checkbox"
            checked={config.includeHoikuen}
            onChange={(e) => props.onUpdate({ includeHoikuen: e.target.checked })}
          />
        </label>
        <label title="駐車場 is billed separately from rent — tick this if you keep a car">
          Add parking to rent
          <input
            type="checkbox"
            checked={config.includeParking}
            onChange={(e) => props.onUpdate({ includeParking: e.target.checked })}
          />
        </label>
        {config.travelMode === "walk" ? (
          <label>
            Walk speed (m/min)
            <input
              type="number"
              min={20}
              step={5}
              value={config.walkSpeedMPerMin}
              onChange={(e) =>
                props.onUpdate({
                  walkSpeedMPerMin: Math.max(20, asNumber(e.target.value, 80)),
                })
              }
            />
          </label>
        ) : (
          <label>
            Cycling speed (m/min)
            <input
              type="number"
              min={60}
              step={10}
              value={config.bicycleSpeedMPerMin}
              onChange={(e) =>
                props.onUpdate({
                  bicycleSpeedMPerMin: Math.max(60, asNumber(e.target.value, 250)),
                })
              }
            />
          </label>
        )}
        <label>
          Detour factor
          <input
            type="number"
            step={0.05}
            min={1}
            value={config.detourFactor}
            onChange={(e) => props.onUpdate({ detourFactor: asNumber(e.target.value, 1.3) })}
          />
        </label>
      </div>

      <div className={styles.actions}>
        <button className="secondary" onClick={props.onExportCsv}>Copy CSV</button>
        <button className="secondary" onClick={props.onExportMarkdown}>Copy Markdown</button>
      </div>
    </section>
  );
}

/**
 * One-click weighting schemes. The preset matching the current weights is
 * highlighted, so after a manual tweak it is clear none is in force.
 */
function PresetRow(props: {
  config: ScoringConfig;
  presets: readonly WeightPreset[];
  onApply: (preset: WeightPreset) => void;
  onSave?: (label: string) => void;
  onDelete?: (id: string) => void;
}) {
  const [naming, setNaming] = useState(false);
  const [label, setLabel] = useState("");
  const save = () => {
    if (!label.trim() || !props.onSave) return;
    props.onSave(label);
    setLabel("");
    setNaming(false);
  };

  return (
    <div className={styles.presets} role="group" aria-label="Weight presets">
      {props.presets.map((preset) => {
        const active = matchesPreset(props.config, preset);
        return (
          <span key={preset.id} className={`${styles.preset} ${active ? styles.presetOn : ""}`}>
            <button
              type="button"
              aria-pressed={active}
              title={`${preset.description}. Changes weights only; anchors stay as they are.`}
              onClick={() => props.onApply(preset)}
            >
              {preset.label}
            </button>
            {preset.custom && props.onDelete && (
              <button
                type="button"
                className={styles.presetDelete}
                aria-label={`Delete preset ${preset.label}`}
                title="Delete this saved preset"
                onClick={() => props.onDelete!(preset.id)}
              >
                ×
              </button>
            )}
          </span>
        );
      })}
      {props.onSave && (naming ? (
        <form
          className={styles.presetSave}
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          <input
            autoFocus
            aria-label="Preset name"
            placeholder="Preset name"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setNaming(false);
            }}
          />
          <button type="submit" disabled={!label.trim()}>Save</button>
          <button type="button" className="secondary" onClick={() => setNaming(false)}>Cancel</button>
        </form>
      ) : (
        <button type="button" className={`secondary ${styles.presetAdd}`} onClick={() => setNaming(true)}>
          Save current as…
        </button>
      ))}
    </div>
  );
}

function Anchor(props: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <span className={styles.anchor}>
      {props.label}
      <input
        type="number"
        value={props.value}
        onChange={(e) => props.onChange(asNumber(e.target.value, props.value))}
      />
    </span>
  );
}
