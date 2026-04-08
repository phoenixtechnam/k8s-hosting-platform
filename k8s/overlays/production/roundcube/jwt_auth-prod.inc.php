<?php
// Production Roundcube config overlay — Phase 3.A.2.
//
// Same as the dev version EXCEPT:
//   - imap_conn_options / smtp_conn_options have verify_peer = true
//   - use_https = true (Roundcube is behind nginx ingress with real TLS)
//   - proxy_whitelist includes common nginx ingress pod CIDRs
//
// Requires Stalwart to be serving a cert that chains to a public CA
// (via k8s/overlays/production/stalwart/) OR a CA bundle mounted
// into the Roundcube pod. By default Stalwart's prod cert comes from
// the platform's cert-manager ClusterIssuer, which uses Let's Encrypt,
// so public CA trust is sufficient and no extra mount is needed.

if (!in_array('jwt_auth', $config['plugins'] ?? [])) {
  $config['plugins'][] = 'jwt_auth';
}

// Point at the in-cluster Stalwart service. Same as dev.
$config['imap_host'] = getenv('ROUNDCUBEMAIL_DEFAULT_HOST');
$config['smtp_host'] = getenv('ROUNDCUBEMAIL_SMTP_SERVER');

// Production: verify the Stalwart TLS cert against the system CA
// bundle. Uses PHP's default certificate store, which on the
// roundcube Docker image is the Debian ca-certificates package.
$config['imap_conn_options'] = [
  'ssl' => [
    'verify_peer'       => true,
    'verify_peer_name'  => true,
    'allow_self_signed' => false,
  ],
];
$config['smtp_conn_options'] = [
  'ssl' => [
    'verify_peer'       => true,
    'verify_peer_name'  => true,
    'allow_self_signed' => false,
  ],
];

// Roundcube sits behind nginx ingress with real HTTPS. Trust the
// X-Forwarded-Proto header so session cookies get the Secure flag.
$config['use_https'] = true;
// nginx-ingress pods are typically in the 10.0.0.0/8 range inside
// k3s. Adjust for your CNI if different.
$config['proxy_whitelist'] = ['10.0.0.0/8', '127.0.0.1'];

$config['username_domain'] = '';

$config['request_check_tokens'] = false;
