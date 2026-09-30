/**
 * Manually add a listing by address (geocoded via GSI) or by raw
 * coordinates. Enriched with the same domain code path as the batch
 * pipeline, then stored alongside the scraped listings.
 */
import { useState, type FormEvent } from "react";
import { enrichListing } from "../../domain/enrichListing";
import { geocodeAddress } from "../../lib/geocode";
import type { EnrichedListing, RawListing } from "../../types";
import styles from "./AddListingForm.module.css";
import appStyles from "../App.module.css";

interface Props {
  onAdd: (listing: EnrichedListing) => void;
}

type Status = { kind: "idle" | "busy" | "ok" | "error"; message: string };

const parseOptional = (raw: string): number | null => {
  if (raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
};

export function AddListingForm({ onAdd }: Props) {
  const [status, setStatus] = useState<Status>({ kind: "idle", message: "" });

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    const text = (key: string) => String(data.get(key) ?? "").trim();

    const raw: RawListing = {
      name: text("name"),
      address: text("address"),
      rent: Number(text("rent")),
      layout: text("layout") || null,
      sizeM2: parseOptional(text("sizeM2")),
      builtYear: parseOptional(text("builtYear")),
      stationWalkMin: parseOptional(text("stationWalkMin")),
      url: null,
      source: "manual",
    };
    const lat = parseOptional(text("lat"));
    const lon = parseOptional(text("lon"));

    setStatus({ kind: "busy", message: "Geocoding…" });
    try {
      let coords = lat != null && lon != null ? { lat, lon, matched: "(manual coordinates)" } : null;
      if (!coords) {
        if (!raw.address) {
          setStatus({ kind: "error", message: "Enter an address or lat/lon." });
          return;
        }
        coords = await geocodeAddress(raw.address);
      }
      if (!coords) {
        setStatus({ kind: "error", message: "Address not found — try lat/lon instead." });
        return;
      }
      onAdd(enrichListing(raw, coords, coords.matched));
      form.reset();
      setStatus({ kind: "ok", message: `Added ✓ (${coords.matched})` });
    } catch {
      setStatus({ kind: "error", message: "Geocoding failed — check network." });
    }
  };

  return (
    <section className={appStyles.card}>
      <h2 className={appStyles.cardTitle}>Add a listing</h2>
      <form className={styles.form} onSubmit={handleSubmit}>
        <Field label="Name" name="name" required placeholder="メゾン草加 301" wide />
        <Field label="Rent (¥/mo)" name="rent" type="number" required placeholder="85000" />
        <Field label="Layout" name="layout" placeholder="2LDK" />
        <Field label="Size (㎡)" name="sizeM2" type="number" step="0.1" placeholder="45" />
        <Field label="Built (year)" name="builtYear" type="number" placeholder="2010" />
        <Field label="Stn walk (min)" name="stationWalkMin" type="number" placeholder="8" />
        <Field label="Address" name="address" placeholder="埼玉県草加市氷川町…" wide />
        <Field label="Lat (optional)" name="lat" type="number" step="any" />
        <Field label="Lon (optional)" name="lon" type="number" step="any" />
        <div className={styles.submit}>
          <button type="submit" disabled={status.kind === "busy"}>
            Add &amp; score
          </button>
          <span className={styles[status.kind]}>{status.message}</span>
        </div>
      </form>
    </section>
  );
}

interface FieldProps {
  label: string;
  name: string;
  type?: string;
  required?: boolean;
  placeholder?: string;
  step?: string;
  wide?: boolean;
}

function Field({ label, wide, ...inputProps }: FieldProps) {
  return (
    <label className={wide ? styles.wide : undefined}>
      <span>{label}</span>
      <input {...inputProps} />
    </label>
  );
}
