/**
 * E2E Test Flow — exercises account creation + email + storage
 *
 * POST /api/test-flow?secret=<TEST_SECRET>
 *
 * Only works with the correct TEST_SECRET env var.
 * Creates a test account, sends welcome email, verifies storage access.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { initDb, createAccount, getAccountByApiKey } from './lib/db.js';
import { sendEmail, welcomeEmailHtml } from './lib/email.js';

const TEST_SECRET = process.env.TEST_SECRET || 'savestate-e2e-test-2026';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST only' });
  }

  const secret = req.query.secret as string;
  if (secret !== TEST_SECRET) {
    return res.status(403).json({ error: 'Invalid test secret' });
  }

  const results: Record<string, unknown> = {};

  try {
    // Step 1: Initialize DB
    await initDb();
    results.db_init = '✅ Database connected and schema ready';

    // Step 2: Create test account
    const testEmail = `test-${Date.now()}@savestate.dev`;
    const account = await createAccount({
      email: testEmail,
      name: 'E2E Test User',
      tier: 'pro',
      stripeCustomerId: `cus_test_${Date.now()}`,
      stripeSubscriptionId: `sub_test_${Date.now()}`,
    });
    results.account_created = {
      status: '✅ Account created',
      id: account.id,
      email: account.email,
      tier: account.tier,
      apiKey: account.api_key.slice(0, 16) + '...',
      storageLimit: `${account.storage_limit_bytes / 1024 / 1024 / 1024} GB`,
    };

    // Step 3: Verify API key lookup
    const looked = await getAccountByApiKey(account.api_key);
    results.api_key_lookup = looked
      ? '✅ API key lookup works'
      : '❌ API key lookup failed';

    // Step 4: Test welcome email (send to David)
    const emailTarget = 'dbhurley@me.com';
    try {
      await sendEmail({
        to: emailTarget,
        subject: `[TEST] SaveState Pro — Your API Key`,
        html: welcomeEmailHtml({
          name: 'David (E2E Test)',
          email: testEmail,
          apiKey: account.api_key,
          tier: 'pro',
        }),
      });
      results.welcome_email = `✅ Sent to ${emailTarget}`;
    } catch (emailErr) {
      results.welcome_email = `❌ Failed: ${(emailErr as Error).message}`;
    }

    // Step 5: Verify account via /api/account format
    const accountCheck = looked ? {
      id: looked.id,
      email: looked.email,
      tier: looked.tier,
      status: looked.stripe_status,
      storage: {
        used: looked.storage_used_bytes,
        limit: looked.storage_limit_bytes,
      },
    } : null;
    results.account_api_response = accountCheck
      ? { status: '✅ Account API would return', data: accountCheck }
      : '❌ Account not found';

    // Summary
    results.summary = {
      allPassed: Object.values(results).every(v =>
        typeof v === 'string' ? v.startsWith('✅') :
        typeof v === 'object' && v !== null ? JSON.stringify(v).includes('✅') : true
      ),
      testAccountEmail: testEmail,
      testApiKey: account.api_key,
      note: 'Test account created in live DB — use API key to test CLI login',
    };

    return res.status(200).json(results);
  } catch (err) {
    results.error = (err as Error).message;
    return res.status(500).json(results);
  }
}
