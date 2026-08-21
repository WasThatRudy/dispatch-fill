# Dispatch Fill

A Chrome/Arc extension (Manifest V3) that fills the job application form you're
looking at, in one click: profile fields, resume upload, a per-job cover message,
an AI-generated cover-letter PDF where the form wants one, and AI answers for
custom questions (dropdowns, multi-selects, radio groups, essay boxes). It never
submits; a review button appears when everything is filled.

Battle-tested against: Greenhouse, Lever, Ashby (formless React DOM), Rippling
(input-less drop zones), Kula, Google Forms (ARIA widgets, Drive-picker uploads),
and Workday-style multi-step wizards (auto-advances through steps, stops before
the final submit).

## How it works

The extension is deliberately thin: page-widget detection and filling live in
`background.js`; everything intelligent (profile data, resume bytes, drafted
messages, Claude-generated answers and cover letters) comes from a companion
[Dispatch](https://github.com/WasThatRudy/dispatch) server on `localhost:4310`.
Without that server running, the extension shows an error and fills nothing.

Field filling notes:
- Answers are matched back to fields by question label, not stored element
  references — SPAs like Google Forms re-render mid-fill and stale references
  end up pointing at the wrong fields.
- AI-answered fields get an amber dashed outline for review; the toast lists
  every question with live status (⏳ answering, ✓ filled, · honestly left
  blank, ✗ field not found).
- Grounding is strict: unknown facts stay blank, disqualifiers get answered
  truthfully, option values are copied exactly from the form's own choices.

## Install

1. `chrome://extensions` (or `arc://extensions`) → enable Developer mode →
   Load unpacked → select this folder. Pin "Dispatch Fill" to the toolbar.
2. Run the Dispatch server (see the Dispatch repo) at `localhost:4310`.
3. Open any application form, click the toolbar icon, review, submit yourself.
