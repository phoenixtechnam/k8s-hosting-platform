/**
 * Email autodiscover / autoconfig / MTA-STS routes.
 *
 * These are PUBLIC endpoints — email clients hit them before any
 * authentication. Do not add auth middleware.
 *
 * The routes live at the platform base URL. Customers point
 * autoconfig.<domain> and autodiscover.<domain> CNAMEs at the
 * platform (done automatically by Phase 3.C.2 DNS provisioning).
 *
 * Endpoints:
 *   GET  /.well-known/autoconfig/mail/config-v1.1.xml?emailaddress=…
 *   POST /Autodiscover/Autodiscover.xml   (XML body, Outlook)
 *   GET  /autodiscover/autodiscover.xml    (lowercase alias)
 *   GET  /.well-known/mta-sts.txt
 *
 * Phase 3.C.1.
 */

import type { FastifyInstance, FastifyReply } from 'fastify';
import { eq } from 'drizzle-orm';
import { emailDomains, domains, clients } from '../../db/schema.js';
import { getMailServerHostname } from '../webmail-settings/service.js';
import {
  renderMozillaAutoconfigXml,
  renderOutlookAutodiscoverXml,
  renderMtaStsPolicyText,
} from './templates.js';

// Very permissive — we only need to extract the domain from
// `user@domain`. Anything more strict risks rejecting legitimate
// addresses.
const EMAIL_RE = /^[^\s@]+@([^\s@]+)$/;

async function resolveDomainForEmail(
  db: FastifyInstance['db'],
  email: string,
): Promise<{ domainName: string; displayName: string } | null> {
  const match = EMAIL_RE.exec(email);
  if (!match) return null;
  const domainPart = match[1].toLowerCase();

  const [row] = await db
    .select({
      domainName: domains.domainName,
      displayName: clients.companyName,
      clientStatus: clients.status,
      enabled: emailDomains.enabled,
    })
    .from(emailDomains)
    .innerJoin(domains, eq(emailDomains.domainId, domains.id))
    .innerJoin(clients, eq(emailDomains.clientId, clients.id))
    .where(eq(domains.domainName, domainPart));

  if (!row) return null;
  if (row.enabled !== 1) return null;
  // Phase 3.C.3: don't advertise autoconfig for suspended clients
  if (row.clientStatus !== 'active') return null;
  return { domainName: row.domainName, displayName: row.displayName };
}

export async function emailAutodiscoverRoutes(app: FastifyInstance): Promise<void> {
  // ─── Mozilla Autoconfig (Thunderbird) ─────────────────────────────
  // GET /.well-known/autoconfig/mail/config-v1.1.xml?emailaddress=alice@acme.com

  app.get('/.well-known/autoconfig/mail/config-v1.1.xml', async (request, reply) => {
    const { emailaddress } = request.query as { emailaddress?: string };
    if (!emailaddress) {
      reply.code(400).type('text/plain').send('Missing emailaddress query parameter');
      return;
    }

    const resolved = await resolveDomainForEmail(app.db, emailaddress);
    if (!resolved) {
      reply.code(404).type('text/plain').send('Domain not configured');
      return;
    }

    const host = await getMailServerHostname(app.db);
    const xml = renderMozillaAutoconfigXml({
      domain: resolved.domainName,
      mailServerHostname: host,
      displayName: resolved.displayName,
    });

    reply.type('application/xml').send(xml);
  });

  // ─── Microsoft Autodiscover (Outlook) ─────────────────────────────
  // POST /Autodiscover/Autodiscover.xml with an XML body containing <EMailAddress>
  // Also GET /autodiscover/autodiscover.xml?email=... for simpler clients

  async function handleAutodiscover(
    emailAddress: string | undefined,
    reply: FastifyReply,
  ) {
    if (!emailAddress) {
      reply.code(400).type('text/plain').send('Missing EMailAddress');
      return;
    }
    const resolved = await resolveDomainForEmail(app.db, emailAddress);
    if (!resolved) {
      reply.code(404).type('text/plain').send('Domain not configured');
      return;
    }
    const host = await getMailServerHostname(app.db);
    const xml = renderOutlookAutodiscoverXml({
      emailAddress,
      mailServerHostname: host,
    });
    reply.type('application/xml').send(xml);
  }

  app.post('/Autodiscover/Autodiscover.xml', async (request, reply) => {
    // Outlook sends an XML body with <EMailAddress>alice@acme.com</EMailAddress>.
    // Parse with a forgiving regex — we only need that one field.
    const body = typeof request.body === 'string' ? request.body : JSON.stringify(request.body ?? '');
    const match = /<EMailAddress[^>]*>([^<]+)<\/EMailAddress>/i.exec(body);
    const emailAddress = match?.[1]?.trim();
    await handleAutodiscover(emailAddress, reply);
  });

  // Lowercase + GET variant for forgiving clients
  app.get('/autodiscover/autodiscover.xml', async (request, reply) => {
    const { email } = request.query as { email?: string };
    await handleAutodiscover(email, reply);
  });

  // ─── MTA-STS policy ───────────────────────────────────────────────
  // GET /.well-known/mta-sts.txt
  // (Served from the mail server hostname's _mta-sts.<domain> CNAME
  // target in production; in dev we just serve it from the platform.)

  app.get('/.well-known/mta-sts.txt', async (_request, reply) => {
    const host = await getMailServerHostname(app.db);
    const text = renderMtaStsPolicyText({
      mailServerHostname: host,
      // Start in 'testing' mode so a misconfigured MX doesn't hard-bounce
      // real mail during bootstrap. Operators can promote to 'enforce'
      // via a future admin setting once they're confident.
      mode: 'testing',
      maxAge: 86400,
    });
    reply.type('text/plain').send(text);
  });
}
