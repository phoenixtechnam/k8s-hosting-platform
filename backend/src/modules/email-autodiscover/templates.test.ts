import { describe, it, expect } from 'vitest';
import {
  renderMozillaAutoconfigXml,
  renderOutlookAutodiscoverXml,
  renderMtaStsPolicyText,
} from './templates.js';

describe('renderMozillaAutoconfigXml', () => {
  it('emits valid XML with IMAP + SMTP config for the given domain', () => {
    const xml = renderMozillaAutoconfigXml({
      domain: 'acme.com',
      mailServerHostname: 'mail.platform.com',
      displayName: 'Acme',
    });

    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain('<clientConfig version="1.1">');
    expect(xml).toContain('<emailProvider id="acme.com">');
    expect(xml).toContain('<domain>acme.com</domain>');
    expect(xml).toContain('<displayName>Acme</displayName>');
    // IMAP incoming
    expect(xml).toContain('<incomingServer type="imap">');
    expect(xml).toContain('<hostname>mail.platform.com</hostname>');
    expect(xml).toContain('<port>993</port>');
    expect(xml).toContain('<socketType>SSL</socketType>');
    expect(xml).toContain('<authentication>password-cleartext</authentication>');
    // SMTP outgoing
    expect(xml).toContain('<outgoingServer type="smtp">');
    expect(xml).toContain('<port>465</port>');
  });

  it('escapes XML special characters in the domain and display name', () => {
    const xml = renderMozillaAutoconfigXml({
      domain: 'foo&bar.com',
      mailServerHostname: 'mail.example.com',
      displayName: 'A <B> & "C"',
    });
    expect(xml).toContain('foo&amp;bar.com');
    expect(xml).toContain('A &lt;B&gt; &amp; &quot;C&quot;');
    // Unescaped characters must not appear
    expect(xml).not.toMatch(/<domain>foo&bar/);
  });

  it('uses %EMAILADDRESS% placeholder for the username template', () => {
    const xml = renderMozillaAutoconfigXml({
      domain: 'acme.com',
      mailServerHostname: 'mail.platform.com',
      displayName: 'Acme',
    });
    expect(xml).toContain('%EMAILADDRESS%');
  });
});

describe('renderOutlookAutodiscoverXml', () => {
  it('emits valid Autodiscover XML for the given email address', () => {
    const xml = renderOutlookAutodiscoverXml({
      emailAddress: 'alice@acme.com',
      mailServerHostname: 'mail.platform.com',
    });

    expect(xml).toContain('<?xml version="1.0" encoding="utf-8"?>');
    expect(xml).toContain('<Autodiscover');
    expect(xml).toContain('<Response');
    expect(xml).toContain('<Type>IMAP</Type>');
    expect(xml).toContain('<Server>mail.platform.com</Server>');
    expect(xml).toContain('<Port>993</Port>');
    expect(xml).toContain('<SSL>on</SSL>');
    // SMTP protocol
    expect(xml).toContain('<Type>SMTP</Type>');
    expect(xml).toContain('<LoginName>alice@acme.com</LoginName>');
  });

  it('escapes XML special characters', () => {
    const xml = renderOutlookAutodiscoverXml({
      emailAddress: 'alice<test>@acme.com',
      mailServerHostname: 'mail.platform.com',
    });
    expect(xml).toContain('alice&lt;test&gt;@acme.com');
  });
});

describe('renderMtaStsPolicyText', () => {
  it('emits a valid MTA-STS policy body', () => {
    const text = renderMtaStsPolicyText({
      mailServerHostname: 'mail.platform.com',
      mode: 'enforce',
      maxAge: 604800,
    });

    expect(text).toContain('version: STSv1');
    expect(text).toContain('mode: enforce');
    expect(text).toContain('mx: mail.platform.com');
    expect(text).toContain('max_age: 604800');
  });

  it('defaults mode to testing for safe rollout', () => {
    const text = renderMtaStsPolicyText({
      mailServerHostname: 'mail.platform.com',
    });
    expect(text).toContain('mode: testing');
  });
});
