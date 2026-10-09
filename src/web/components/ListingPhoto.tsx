/**
 * Listing pictures that skip photos the portal does not have.
 *
 * Photo URLs are derived (see domain/listingPhotos), so some point at nothing:
 * the image fails to load, or SUUMO answers with its small "no image"
 * placeholder. Either way the URL is recorded as unavailable once, and every
 * thumbnail and gallery showing that listing moves on to its next picture.
 */
import { useState, useSyncExternalStore } from "react";
import { PHOTO_KIND_LABELS, type ListingPhoto } from "../../domain/listingPhotos";
import styles from "./ListingPhoto.module.css";

/** SUUMO's missing-photo placeholder is 100×100; real pictures are larger. */
const PLACEHOLDER_MAX_SIDE = 100;

const unavailable = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;

function markUnavailable(url: string) {
  if (unavailable.has(url)) return;
  unavailable.add(url);
  version += 1;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Forget every recorded missing photo (tests share the module between cases). */
export function resetUnavailablePhotos() {
  unavailable.clear();
  version += 1;
  for (const listener of listeners) listener();
}

/**
 * The photos not yet known to be missing. The snapshot is this listing's own
 * available URLs, so a missing photo re-renders only the views that showed it.
 */
function useAvailablePhotos(photos: readonly ListingPhoto[]): ListingPhoto[] {
  const key = useSyncExternalStore(subscribe, () =>
    photos.filter((photo) => !unavailable.has(photo.url)).map((photo) => photo.url).join("\n"));
  const urls = new Set(key.split("\n"));
  return photos.filter((photo) => urls.has(photo.url));
}

function Photo({ photo, className, alt, eager }: { photo: ListingPhoto; className?: string; alt: string; eager?: boolean }) {
  const [loaded, setLoaded] = useState(false);
  return (
    <img
      className={`${className ?? ""} ${loaded ? styles.loaded : styles.loading}`}
      src={photo.url}
      alt={alt}
      loading={eager ? "eager" : "lazy"}
      decoding="async"
      referrerPolicy="no-referrer"
      draggable={false}
      onLoad={(event) => {
        const { naturalWidth, naturalHeight } = event.currentTarget;
        if (naturalWidth <= PLACEHOLDER_MAX_SIDE && naturalHeight <= PLACEHOLDER_MAX_SIDE) markUnavailable(photo.url);
        else setLoaded(true);
      }}
      onError={() => markUnavailable(photo.url)}
    />
  );
}

function NoPhoto({ className, label }: { className?: string; label?: string }) {
  return (
    <span className={`${styles.empty} ${className ?? ""}`} title="No photo from this listing's portals" aria-hidden={!label}>
      <svg viewBox="0 0 24 24" width="40%" height="40%" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round">
        <path d="M3 11.5 12 4l9 7.5" />
        <path d="M5.5 10v9.5h13V10" />
        <path d="M10 19.5v-5h4v5" />
      </svg>
      {label && <small>{label}</small>}
    </span>
  );
}

/** " 2", " 3" … for the second and later photo of the same kind; "" otherwise. */
function ordinalOfKind(photos: readonly ListingPhoto[], index: number): string {
  const kind = photos[index].kind;
  if (photos.filter((photo) => photo.kind === kind).length < 2) return "";
  return ` ${photos.slice(0, index + 1).filter((photo) => photo.kind === kind).length}`;
}

/** A small fixed-size thumbnail: the first available photo, else a house glyph. */
export function ListingThumb({ photos, name, className }: { photos: readonly ListingPhoto[]; name: string; className?: string }) {
  const [photo] = useAvailablePhotos(photos);
  if (!photo) return <NoPhoto className={`${styles.thumb} ${className ?? ""}`} />;
  return (
    <span className={`${styles.thumb} ${className ?? ""}`}>
      <Photo
        key={photo.url}
        photo={photo}
        className={photo.kind === "floorPlan" ? styles.contain : styles.cover}
        alt={`${PHOTO_KIND_LABELS[photo.kind].en} of ${name}`}
      />
    </span>
  );
}

/**
 * A larger picture with one tab per available photo (exterior, floor plan …).
 * Renders nothing when the listing has no photo candidates at all.
 */
export function PhotoGallery({ photos, name, className }: { photos: readonly ListingPhoto[]; name: string; className?: string }) {
  const available = useAvailablePhotos(photos);
  const [chosen, setChosen] = useState<string | null>(null);
  if (!photos.length) return null;
  const current = available.find((photo) => photo.url === chosen) ?? available[0];
  return (
    <figure className={`${styles.gallery} ${className ?? ""}`}>
      <div className={styles.stage}>
        {current ? (
          <Photo
            key={current.url}
            photo={current}
            eager
            className={current.kind === "floorPlan" ? styles.contain : styles.cover}
            alt={`${PHOTO_KIND_LABELS[current.kind].en} of ${name}`}
          />
        ) : (
          <NoPhoto label="No photos available" />
        )}
      </div>
      {available.length > 1 && (
        <div className={styles.tabs} role="group" aria-label="Listing photos">
          {available.map((photo, index) => (
            <button
              key={photo.url}
              type="button"
              aria-pressed={photo === current}
              className={photo === current ? styles.activeTab : undefined}
              onClick={(event) => {
                event.stopPropagation();
                setChosen(photo.url);
              }}
            >
              {PHOTO_KIND_LABELS[photo.kind].en}
              {/* Cross-listed rooms can have several ads, each with its own pictures. */}
              {ordinalOfKind(available, index)}
              <small>{PHOTO_KIND_LABELS[photo.kind].ja}</small>
            </button>
          ))}
        </div>
      )}
    </figure>
  );
}
