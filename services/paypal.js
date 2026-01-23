// services/paypal.js
require('dotenv').config();

const PAYPAL_CLIENT = (process.env.PAYPAL_CLIENT_ID || '').trim();
const PAYPAL_SECRET = (process.env.PAYPAL_CLIENT_SECRET || '').trim();

// IMPORTANT:
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
  // Fallback for older Node: dynamic import (node-fetch v3 is ESM-only)
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

async function getAccessToken() {
  assertEnv();
  const fetchFn = await getFetch();

  const response = await fetchFn(`${PAYPAL_API}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization:
        'Basic ' + Buffer.from(`${PAYPAL_CLIENT}:${PAYPAL_SECRET}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });

  const parsed = await readJsonOrText(response);

  if (!response.ok) {
    console.error('PayPal getAccessToken failed:', response.status, parsed.data);
    throw new Error(`PayPal token error (${response.status})`);
  }

  if (!parsed.isJson || !parsed.data?.access_token) {
    console.error('PayPal token response invalid:', parsed.data);
    throw new Error('PayPal token response invalid');
  }

  return parsed.data.access_token;
}

async function createOrder(amount, currency = 'SGD') {
  assertEnv();

  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`Invalid amount: ${amount}`);
  }

  const accessToken = await getAccessToken();
  const fetchFn = await getFetch();

  const response = await fetchFn(`${PAYPAL_API}/v2/checkout/orders`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
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
    throw new Error(`PayPal create order error (${response.status})`);
  }

  if (!parsed.isJson || !parsed.data?.id) {
    console.error('PayPal createOrder response invalid:', parsed.data);
    throw new Error('PayPal createOrder response invalid (missing id)');
  }

  return parsed.data; // includes .id
}

async function captureOrder(orderId) {
  assertEnv();
  if (!orderId || typeof orderId !== 'string') throw new Error('Missing orderId');

  const accessToken = await getAccessToken();
  const fetchFn = await getFetch();

  const response = await fetchFn(`${PAYPAL_API}/v2/checkout/orders/${orderId}/capture`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
  });

  const parsed = await readJsonOrText(response);

  if (!response.ok) {
    console.error('PayPal captureOrder failed:', response.status, parsed.data);
    throw new Error(`PayPal capture order error (${response.status})`);
  }

  if (!parsed.isJson) {
    console.error('PayPal captureOrder returned non-JSON:', parsed.data);
    throw new Error('PayPal captureOrder returned non-JSON');
  }

  return parsed.data;
}

module.exports = { createOrder, captureOrder };
