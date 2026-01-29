    // services/airwallex.js
    require('dotenv').config();

    const BASE_URL = (process.env.AIRWALLEX_BASE_URL || 'https://api-demo.airwallex.com').trim();
    const CLIENT_ID = (process.env.AIRWALLEX_CLIENT_ID || '').trim();
    const API_KEY = (process.env.AIRWALLEX_API_KEY || '').trim();

    function assertEnv() {
    if (!CLIENT_ID || !API_KEY) throw new Error('Missing AIRWALLEX_CLIENT_ID or AIRWALLEX_API_KEY');
    }

    async function getFetch() {
    if (typeof fetch === 'function') return fetch; // Node 18+
    const mod = await import('node-fetch');
    return mod.default;
    }

    async function readJson(res) {
    const text = await res.text();
    try { return JSON.parse(text); } catch { return { raw: text }; }
    }

    async function login() {
    assertEnv();
    const fetchFn = await getFetch();

    const res = await fetchFn(`${BASE_URL}/api/v1/authentication/login`, {
        method: 'POST',
        headers: {
        'Content-Type': 'application/json',
        'x-client-id': CLIENT_ID,
        'x-api-key': API_KEY,
        },
        body: JSON.stringify({}),
    });

    const body = await readJson(res);
    if (!res.ok) throw new Error(`Airwallex login failed (${res.status}): ${JSON.stringify(body)}`);

    const token = body?.token;
    if (!token) throw new Error('Airwallex login missing token');
    return token;
    }

    async function createPaymentIntent({ requestId, amount, currency, merchantOrderId, returnUrl }) {
    const token = await login();
    const fetchFn = await getFetch();

    const res = await fetchFn(`${BASE_URL}/api/v1/pa/payment_intents/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
        request_id: requestId,
        amount: Number(amount),
        currency,
        merchant_order_id: merchantOrderId,
        return_url: returnUrl,
        }),
    });

    const body = await readJson(res);
    if (!res.ok) throw new Error(`Create PaymentIntent failed (${res.status}): ${JSON.stringify(body)}`);
    return body;
    }

    async function confirmTngQr({ requestId, paymentIntentId }) {
    const token = await login();
    const fetchFn = await getFetch();

    const res = await fetchFn(`${BASE_URL}/api/v1/pa/payment_intents/${paymentIntentId}/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
        request_id: requestId,
        payment_method: { type: 'tng', tng: { flow: 'qrcode' } },
        }),
    });

    const body = await readJson(res);
    if (!res.ok) throw new Error(`Confirm PaymentIntent failed (${res.status}): ${JSON.stringify(body)}`);
    return body;
    }

    async function retrievePaymentIntent(paymentIntentId) {
    const token = await login();
    const fetchFn = await getFetch();

    const res = await fetchFn(`${BASE_URL}/api/v1/pa/payment_intents/${paymentIntentId}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
    });

    const body = await readJson(res);
    if (!res.ok) throw new Error(`Retrieve PaymentIntent failed (${res.status}): ${JSON.stringify(body)}`);
    return body;
    }

    module.exports = { createPaymentIntent, confirmTngQr, retrievePaymentIntent };
