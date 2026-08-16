# Apps Script backend — moved

The backend that receives this site's feedback and error reports now lives in
one place:

**https://github.com/YAL-PJ/apps-script-backend** → `src/feedback-backend.gs`

The copy that used to sit here described a 14-column `Errors` schema that was
**never deployed** — the live sheet had 10 columns. As a result the `code`,
`sessionId` and `fileName` fields this site's tracker sends were being silently
dropped. The canonical version appends those columns, so they are now recorded.

(`apps-script.gs` in the repo root was an older pointer to that file and has
been removed too.)

## This site's wiring

- `index.html` → `FEEDBACK_ENDPOINT`, posts `{ app: 'splitpdf', ... }`
- `error-tracker.js` → posts `{ action: 'error_report', type: 'error', ... }`.
  Both keys are sent; the canonical backend accepts either.

The endpoint URL is stable. To change backend behaviour, edit and deploy from
the canonical repo — do not paste code into the Apps Script editor by hand.
