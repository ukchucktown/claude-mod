// Text from a request reaches a person in a dialog, a grant list, or a note.
// A character that changes the direction or the layout of that text can show
// another app than the one that the request names. This module has no host
// call and no Node API, so the Mod and the launcher share it.

// The characters that change direction or layout:
// - U+0000 to U+001F and U+007F to U+009F, the C0 and C1 control characters,
//   which include the line break and the tab.
// - U+2028 and U+2029, the line separator and the paragraph separator.
// - The Unicode Bidi_Control set: U+061C, U+200E, U+200F, U+202A to U+202E,
//   and U+2066 to U+2069.
const LAYOUT =
  "\\u0000-\\u001F\\u007F-\\u009F\\u061C\\u200E\\u200F\\u2028-\\u202E\\u2066-\\u2069";
const ONE = new RegExp(`[${LAYOUT}]`);
const EACH = new RegExp(`[${LAYOUT}]`, "g");

// Whether a string holds a character that changes direction or layout.
export const changesLayout = (value: string): boolean => ONE.test(value);

// Prepares a request string for display. Each character that changes
// direction or layout becomes its code point in the visible form \u{202E},
// with at least four hexadecimal digits. The person thus sees one line in one
// direction, and sees that the string is unusual. All other characters stay.
export const displayText = (value: string): string =>
  value.replace(
    EACH,
    (character) =>
      `\\u{${character.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}}`,
  );
