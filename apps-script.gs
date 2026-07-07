// This file has moved to google-apps-script/feedback-backend.gs as part of the
// shared feedback system that powers all 4 of Yanis's PDF apps.
// See google-apps-script/feedback-backend.gs for the live backend and setup
// instructions. Deploy that file once (Extensions -> Apps Script -> Deploy as
// Web app) and paste the /exec URL into FEEDBACK_ENDPOINT in index.html.
//
// The backend already handles error tracking: client-side errors are posted
// with { action: 'error_report', app: 'splitpdf', ... } and logged to the
// "Errors" tab in the Google Sheet automatically.
