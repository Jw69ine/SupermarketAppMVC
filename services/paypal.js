// services/paypal.js
require('dotenv').config();

const PAYPAL_CLIENT = (process.env.PAYPAL_CLIENT_ID || '').trim();
const PAYPAL_SECRET = (process.env.PAYPAL_CLIENT_SECRET || '').trim();

// Sandbox: https://api-m.sandbox.paypal.com
// Live:    https://api-m.paypal.com
const PAYPAL_API = (process.env.PAYPAL_API || '').trim();

function assertEnv() {
  if (!PAYPAL_CLIENT) throw new Error('Missing PAYPAL_CLIENT_ID in .env');
  if (!PAYPAL_SECRET) throw new Error('Missing PAYPAL_CLIENT_SECRET in .env');
  if (!PAYPAL_API) throw new Error('Missing PAYPAL_API in .env');
}

async function getFetch() {
  if (typeof fetch === 'function') return fetch; // Node 18+ has global fetch
  const mod = await import('node-fetch');
  return mod.default;
}

async function readJsonOrText(response) {
  const text = await response.text();
  try {
    return { isJson: true, data: JSON.parse(text) };
  } catch {
    return { isJson: false, data: text };
  }
}

function buildError(prefix, response, parsed) {
  const detail =
    parsed?.isJson && parsed?.data
      ? JSON.stringify(parsed.data)
      : String(parsed?.data ?? '');

  return new Error(`${prefix} (HTTP ${response.status}) ${detail}`);
}

async function getAccessToken() {
  assertEnv();
  const fetchFn = await getFetch();

  const response = await fetchFn(`${PAYPAL_API}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization:
        'Basic ' +
        Buffer.from(`${PAYPAL_CLIENT}:${PAYPAL_SECRET}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });

  const parsed = await readJsonOrText(response);

  if (!response.ok) {
    console.error('PayPal getAccessToken failed:', response.status, parsed.data);
    throw buildError('PayPal token error', response, parsed);
  }

  if (!parsed.isJson || !parsed.data?.access_token) {
    console.error('PayPal token response invalid:', parsed.data);
    throw new Error('PayPal token response invalid (missing access_token)');
  }

  return parsed.data.access_token;
}

/**
 * Create a PayPal order.
 * Returns the full order JSON.
 */
async function createOrder(amount, currency = 'SGD', options = {}) {
  assertEnv();

  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`Invalid amount: ${amount}`);
  }

  const accessToken = await getAccessToken();
  const fetchFn = await getFetch();

  const requestId =
    options.requestId || `order-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  const response = await fetchFn(`${PAYPAL_API}/v2/checkout/orders`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
      // Idempotency (recommended so refresh/retry doesn't create duplicate orders)
      'PayPal-Request-Id': requestId,
    },
    body: JSON.stringify({
      intent: 'CAPTURE',
      purchase_units: [
        {
          amount: {
            currency_code: currency,
            value: n.toFixed(2),
          },
        },
      ],
    }),
  });

  const parsed = await readJsonOrText(response);

  if (!response.ok) {
    console.error('PayPal createOrder failed:', response.status, parsed.data);
    throw buildError('PayPal create order error', response, parsed);
  }

  if (!parsed.isJson || !parsed.data?.id) {
    console.error('PayPal createOrder response invalid:', parsed.data);
    throw new Error('PayPal createOrder response invalid (missing id)');
  }

  return parsed.data;
}

/**
 * Convenience for PayPal JS Buttons `createOrder`:
 * Must resolve to the ORDER ID string, otherwise you can get
 * "Expected an order id to be passed" in the browser. [file:203][web:581]
 */
async function createOrderId(amount, currency = 'SGD', options = {}) {
  const order = await createOrder(amount, currency, options);
  return order.id;
}

/**
 * Capture an approved order.
 * PayPal capture endpoint: POST /v2/checkout/orders/{id}/capture [web:93]
 */
async function captureOrder(orderId, options = {}) {
  assertEnv();
  if (!orderId || typeof orderId !== 'string') throw new Error('Missing orderId');

  const accessToken = await getAccessToken();
  const fetchFn = await getFetch();

  const requestId =
    options.requestId || `capture-${orderId}-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  const response = await fetchFn(
    `${PAYPAL_API}/v2/checkout/orders/${orderId}/capture`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
        'PayPal-Request-Id': requestId,
      },
    }
  );

  const parsed = await readJsonOrText(response);

  if (!response.ok) {
    console.error('PayPal captureOrder failed:', response.status, parsed.data);
    throw buildError('PayPal capture order error', response, parsed);
  }

  if (!parsed.isJson) {
    console.error('PayPal captureOrder returned non-JSON:', parsed.data);
    throw new Error('PayPal captureOrder returned non-JSON');
  }

  return parsed.data;
}

/**
 * Refund a captured payment.
 * Endpoint: POST /v2/payments/captures/{capture_id}/refund.
 * For full refund, an empty JSON body is valid. [web:406]
 */
async function refundCapturedPayment(
  captureId,
  amount = null,
  currency = 'SGD',
  note = 'Customer refund request approved',
  options = {}
) {
  assertEnv();
  if (!captureId || typeof captureId !== 'string') throw new Error('Missing captureId');

  const accessToken = await getAccessToken();
  const fetchFn = await getFetch();

  const requestId =
    options.requestId || `refund-${captureId}-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  const bodyObj =
    amount == null
      ? { note_to_payer: note } // still ok; you can also use {} for full refund [web:406]
      : {
          amount: {
            value: Number(amount).toFixed(2),
            currency_code: currency,
          },
          note_to_payer: note,
        };

  const response = await fetchFn(
    `${PAYPAL_API}/v2/payments/captures/${captureId}/refund`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
        'PayPal-Request-Id': requestId,
      },
      body: JSON.stringify(bodyObj),
    }
  );

  const parsed = await readJsonOrText(response);

  if (!response.ok) {
    console.error('PayPal refundCapturedPayment failed:', response.status, parsed.data);
    throw buildError('PayPal refund error', response, parsed);
  }

  if (!parsed.isJson) {
    console.error('PayPal refundCapturedPayment returned non-JSON:', parsed.data);
    throw new Error('PayPal refundCapturedPayment returned non-JSON');
  }

  return parsed.data;
}

module.exports = {
  createOrder,
  createOrderId,
  captureOrder,
  refundCapturedPayment,
};
