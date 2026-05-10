// `claw webhook ...` — register, list, test, remove webhook
// subscriptions. The signing secret is shown ONCE at create time and
// then forgotten by the hub-side projection (it's still stored
// server-side so the worker can sign — we just don't surface it to
// future GETs).

import { Command } from 'commander';
import { api } from '../client/api.js';

interface ApiWebhook {
  id:               number;
  url:              string;
  events:           string[];
  filters:          Record<string, unknown>;
  status:           'active' | 'unhealthy';
  createdAt:        string;
  lastDeliveryAt:   string | null;
}

const webhookAdd = new Command('add')
  .description('register a webhook subscription')
  .requiredOption('--url <url>',           'https://… target endpoint')
  .requiredOption('--events <csv>',        'comma-separated event types (or "*" for all)')
  .option('--routing-name <handle>',       'narrow to events for one session by routing name (e.g. @orchard-viper). Stable across managed-session restart / autoStart-respawn / kill+restart cycles, where sessionId would churn.')
  .action(async (opts: { url: string; events: string; routingName?: string }) => {
    const events = opts.events.split(',').map((s) => s.trim()).filter(Boolean);
    const filters: Record<string, unknown> = {};
    if (opts.routingName) {
      // Normalize: hub stores the @-prefixed form; accept either input.
      filters.routingName = opts.routingName.startsWith('@') ? opts.routingName : '@' + opts.routingName;
    }
    const out = await api.post<ApiWebhook & { signingSecret: string }>('/api/v1/webhooks', {
      url: opts.url, events, filters,
    });
    console.log(`✓ webhook ${out.id} registered`);
    console.log(`  url:    ${out.url}`);
    console.log(`  events: ${out.events.join(', ')}`);
    if (Object.keys(out.filters).length) console.log(`  filters: ${JSON.stringify(out.filters)}`);
    console.log(`  signing secret (shown ONCE): ${out.signingSecret}`);
    console.log('');
    console.log('  verify each delivery with:');
    console.log('    HMAC-SHA256(<secret>, "<ts>." + rawBody) === <v1 from X-Clawborrator-Signature header>');
  });

const webhookList = new Command('list')
  .alias('ls')
  .description('list webhook subscriptions')
  .action(async () => {
    const data = await api.get<{ items: ApiWebhook[] }>('/api/v1/webhooks');
    if (data.items.length === 0) { console.log('no webhooks'); return; }
    for (const w of data.items) {
      const last = w.lastDeliveryAt ? `last ${w.lastDeliveryAt}` : 'never delivered';
      const evs = w.events.join(',');
      console.log(`${w.id.toString().padStart(3)}  ${w.status.padEnd(9)} ${w.url}`);
      console.log(`     events: ${evs}  ·  ${last}`);
    }
  });

const webhookTest = new Command('test')
  .description('send a synthetic webhook.test event')
  .argument('<id>', 'subscription id (from `claw webhook list`)')
  .action(async (id: string) => {
    const out = await api.post<{ eventId: string }>(`/api/v1/webhooks/${encodeURIComponent(id)}/test`);
    console.log(`✓ test event queued: ${out.eventId}`);
    console.log('  worker will deliver within ~10s.');
  });

const webhookRm = new Command('rm')
  .alias('delete')
  .description('remove a webhook subscription')
  .argument('<id>', 'subscription id')
  .action(async (id: string) => {
    await api.delete(`/api/v1/webhooks/${encodeURIComponent(id)}`);
    console.log(`✓ webhook ${id} removed`);
  });

export const webhookCmd = new Command('webhook')
  .description('manage webhook subscriptions')
  .addCommand(webhookAdd)
  .addCommand(webhookList)
  .addCommand(webhookTest)
  .addCommand(webhookRm);
