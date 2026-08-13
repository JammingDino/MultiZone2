/**
 * Sizes for the chat header's row of controls.
 *
 * They were set one component at a time and had drifted between 11 and 15px,
 * which reads as a row of mismatched glyphs rather than one toolbar — and the
 * smallest of them (the spend figure's) was too small to identify at a glance.
 * One number, imported by every control in the row, so the next one added lands
 * at the same size as the rest.
 */
export const HEADER_ICON = 13;

/** Secondary affordances *inside* a header control — the disclosure chevron on a
 *  dropdown, which should read as attached to its label rather than as another
 *  item in the row. */
export const HEADER_CHEVRON = 12;

/**
 * The message action bar's glyphs (Copy, Regenerate, Edit, Branch…). Bigger
 * than the 11px they were written at, because the bar dropped its labels: an
 * icon carrying the whole meaning has to be identifiable on its own.
 */
export const ACTION_ICON = 12;

/**
 * One hover for every piece of chrome — header controls, composer buttons, the
 * message action bar.
 *
 * Export and Perspectives lit up in the accent colour; everything beside them
 * filled with a grey panel background instead, so one row of controls answered
 * the pointer two different ways. These say it once: chrome is muted at rest
 * and glows accent — outline and glyph together — under the pointer.
 *
 * Callers supply their own layout (flex, gap, padding, corner radius); these
 * cover only the parts that should match everywhere.
 */
export const CHROME_GLOW =
  "transition hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]";

/**
 * A control with no outline at rest — icon buttons and value readouts. The
 * border is present but transparent, so the glow appears without the control
 * changing size and nudging its neighbours along the row.
 */
export const CHROME_QUIET = `border border-transparent text-[var(--color-text-muted)] ${CHROME_GLOW}`;

/** A control outlined at rest — the labelled dropdown chips (Export, Perspectives, mode). */
export const CHROME_OUTLINED = `border border-[var(--color-border)] text-[var(--color-text-muted)] ${CHROME_GLOW}`;

/**
 * A control that is currently on or open. Same accent as the hover state, held
 * rather than transient, so "open" and "about to be clicked" look related
 * instead of a dropdown going grey while its neighbour goes blue.
 */
export const CHROME_ACTIVE = "border border-[var(--color-accent)] text-[var(--color-accent)] transition";
