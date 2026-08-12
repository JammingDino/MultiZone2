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
