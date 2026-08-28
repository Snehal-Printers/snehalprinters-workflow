MAILCHANNELS SETUP — ADD THESE AT YOUR CURRENT DNS PROVIDER
(cPanel / registrar panel for snehalprinters.in — no Cloudflare migration needed)
=================================================================================

You are adding 1 new TXT record and editing 1 existing TXT record. Everything else
(MX, DKIM, DMARC, A records) stays exactly as it is — do not touch them.


STEP 1 — EDIT your existing SPF record
---------------------------------------
Find this existing TXT record (Host/Name: @ or snehalprinters.in):

  CURRENT VALUE:
  v=spf1 +a +mx +ip4:23.88.64.33 ~all

  CHANGE IT TO:
  v=spf1 +a +mx +ip4:23.88.64.33 include:relay.mailchannels.net ~all

(Just adding "include:relay.mailchannels.net " before the ~all. Do not create a second
SPF/TXT record — a domain can only have one SPF record, adding a second one breaks mail.)


STEP 2 — ADD a new TXT record for MailChannels domain lockdown
-----------------------------------------------------------------
Type:  TXT
Host/Name:  _mailchannels
Value:  v=mc1 cfid=REPLACE_WITH_YOUR_WORKERS_DEV_SUBDOMAIN.workers.dev
TTL:  Auto (or 3600 / 1 hour if no Auto option)

Get REPLACE_WITH_YOUR_WORKERS_DEV_SUBDOMAIN from your Cloudflare dashboard:
  Workers & Pages -> your worker (snehal-leadgen-api) -> the URL shown will look like
  https://snehal-leadgen-api.XXXXXXXX.workers.dev
  Use just the XXXXXXXX part (your account's workers.dev subdomain) in the record above.

Example (do not use as-is, use YOUR actual subdomain):
  v=mc1 cfid=johndoe123.workers.dev


STEP 3 — WAIT for propagation
-------------------------------
10 minutes to a few hours depending on your DNS provider's TTL. No nameserver change,
no website/email downtime expected since MX and existing SPF target IP are untouched.


STEP 4 — VERIFY it works
---------------------------
Run this from any terminal (replace the "to" email with an inbox you can check):

curl -X POST https://api.mailchannels.net/tx/v1/send \
  -H "Content-Type: application/json" \
  -d '{
    "personalizations": [{"to": [{"email": "your-own-test-inbox@gmail.com"}]}],
    "from": {"email": "leads@snehalprinters.in", "name": "Snehal Printers Test"},
    "subject": "MailChannels test",
    "content": [{"type": "text/plain", "value": "If you got this, MailChannels is working."}]
  }'

Success = HTTP 202 and the email arrives (check spam folder for the first few sends).

If you get a 401 / "domain lockdown" error -> the _mailchannels TXT record is missing,
wrong, or hasn't propagated yet. Double check the cfid value matches your actual
workers.dev subdomain exactly.


REMINDER — set SENDER_EMAIL to match
--------------------------------------
Whatever address you use in the "from" field (e.g. leads@snehalprinters.in) must be set
as the SENDER_EMAIL secret in Cloudflare Secrets Store for the worker, so the pipeline's
outgoing outreach + approval-notification emails use the same authorized address.