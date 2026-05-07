<?php
/*
 * Platform branding config — included by the Roundcube docker
 * entrypoint via the *.inc.php glob in /var/roundcube/config/.
 *
 * IMPORTANT: this file runs INSIDE the rcmail::get_instance()
 * config-load path. Any call back into rcmail::get_instance() from
 * here causes infinite recursion → PHP memory_limit exhaustion
 * (we hit this once already on 2026-05-07). Keep this file to pure
 * config-array assignments. Hook registration lives in the
 * platform_branding plugin (k8s/base/roundcube/branding-plugin/),
 * which Roundcube loads after the singleton finishes building.
 */

$config['product_name'] = 'K8s Hosting Platform Webmail';

// skin_logo accepts a string OR a state→url map. The state '*' covers
// every screen that doesn't have a more specific entry.
//   '*'         — default skin logo (top bar after login)
//   'login'     — login screen logo
//   '[favicon]' — browser tab icon
$config['skin_logo'] = [
  '*'         => '/branding/logo.svg',
  'login'     => '/branding/logo.svg',
  '[favicon]' => '/branding/logo.svg',
];

// Enable the platform_branding plugin. The plugin registers the
// html_head hook that injects /branding/branding.css on every page.
// jwt_auth.inc.php uses the same `if (!in_array)` guard pattern.
if (!isset($config['plugins']) || !is_array($config['plugins'])) {
  $config['plugins'] = [];
}
if (!in_array('platform_branding', $config['plugins'])) {
  $config['plugins'][] = 'platform_branding';
}
