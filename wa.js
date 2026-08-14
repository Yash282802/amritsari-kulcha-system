// WhatsApp Business Cloud API sender.
// Configure with env: WA_TOKEN (permanent token), WA_PHONE_ID (phone-number id),
// WA_TEST_TO (optional: force all sends to this number for testing).
// When unconfigured, every call returns { status: 'skipped' } so the app keeps working.

const TOKEN = process.env.WA_TOKEN;
const PHONE_ID = process.env.WA_PHONE_ID;
const TEST_TO = process.env.WA_TEST_TO || '';

export async function sendTemplate(to, templateName, params = []) {
  if (!TOKEN || !PHONE_ID) return { status: 'skipped' };
  const body = {
    messaging_product: 'whatsapp',
    to: TEST_TO || to,
    type: 'template',
    template: {
      name: templateName,
      language: { code: 'en' },
      components: [{ type: 'body', parameters: params.map(p => ({ type: 'text', text: String(p) })) }],
    },
  };
  const r = await fetch(`https://graph.facebook.com/v21.0/${PHONE_ID}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  const status = r.ok ? 'sent' : 'failed';
  if (!r.ok) console.log(`[wa] ${templateName} -> ${TEST_TO || to} failed: ${data.error?.code} ${data.error?.message}`);
  return { status, message: data.error?.message };
}
