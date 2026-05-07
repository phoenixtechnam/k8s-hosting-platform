<?php
/**
 * jwt_auth — JWT-based SSO for Roundcube.
 *
 * Verifies an HS256 JWT (passed as ?_jwt=... on /?_task=login), extracts
 * the `mailbox` claim, and uses Stalwart Mail Server's master-user mode
 * to log the user in via IMAP without prompting for a password.
 *
 * The JWT is signed by the platform backend (Fastify + @fastify/jwt) and
 * the same secret must be available to this plugin via JWT_AUTH_SECRET.
 *
 * Required environment variables on the Roundcube container:
 *   JWT_AUTH_SECRET           — HS256 secret, identical to the backend's JWT_SECRET
 *   STALWART_MASTER_USER      — master user name (default: "master")
 *   STALWART_MASTER_PASSWORD  — cleartext master password
 *
 * Required Roundcube config (in /var/roundcube/config/jwt_auth.inc.php):
 *   $config['plugins'][] = 'jwt_auth';
 *
 * Hooks:
 *   - startup (any task): detects ?_jwt=, verifies, populates POST fields
 *     so Roundcube's normal login flow takes over with the master credentials
 *   - logged_in: rewrites the displayed username to strip the master suffix
 *     (Stalwart needs `<mailbox>%<master>` for IMAP auth, but we don't want
 *     that ugly string visible in the UI)
 */

class jwt_auth extends rcube_plugin
{
    public $task = '.*';

    function init()
    {
        $this->add_hook('startup', array($this, 'on_startup'));
        // Roundcube does NOT expose a `logged_in` hook (verified
        // empirically 2026-05-07: grep'd /var/www/html/program/ for
        // exec_hook calls; only `login_after`, `login_failed`,
        // `loginform_content`, and `oauth_login` exist for the auth
        // flow). The `login_after` hook fires after rcmail::login()
        // succeeds, by both the regular form-login path AND our own
        // on_startup() JWT path (which dispatches login_after at the
        // end of its flow). Register here so the user.username +
        // identity rewrite runs on every successful authentication.
        $this->add_hook('login_after', array($this, 'on_logged_in'));
        // template_object_username fires whenever Roundcube renders the
        // top-right "username" template object. We swap the rendered
        // string from the master-form to the clean mailbox address —
        // see the docblock above on_template_object_username for why
        // this must NOT touch $_SESSION['username'].
        $this->add_hook('template_object_username', array($this, 'on_template_object_username'));
        // render_page is a defence-in-depth filter against any
        // template that leaks the master form into the rendered HTML
        // (e.g. the From: dropdown if the identity-rewrite missed it).
        $this->add_hook('render_page', array($this, 'on_render_page'));
    }

    /**
     * Detect ?_jwt=<token> on any request. When a valid JWT is present,
     * authenticate directly via rcmail::login() using Stalwart master-user
     * credentials, then redirect to the mail view. No POST form needed.
     *
     * Why programmatic login instead of a form-POST?
     *   - Roundcube's login-action POST handler requires
     *     `$_SESSION['temp'] = true` AND a matching session cookie AND
     *     (optionally) a request token, and the session layer Roundcube
     *     installs is stricter than PHP's default — writes to $_SESSION
     *     from a startup hook don't always survive to the next request.
     *   - Calling rcmail::login() directly bypasses all of that. On
     *     success, rcmail writes the authenticated session itself and
     *     we redirect the client to /?_task=mail.
     *   - The JWT never appears in a POSTed form body and never leaves
     *     this handler — only the resulting session cookie goes to the
     *     browser.
     */
    function on_startup($args)
    {
        $jwt = rcube_utils::get_input_value('_jwt', rcube_utils::INPUT_GP);
        if (!$jwt) {
            return $args;
        }

        $secret = getenv('JWT_AUTH_SECRET');
        if (!$secret) {
            rcube::raise_error(array(
                'code' => 500,
                'message' => 'jwt_auth: JWT_AUTH_SECRET env var not set'
            ), true, false);
            return $args;
        }

        $payload = $this->verify_jwt($jwt, $secret);
        if (!$payload || empty($payload['mailbox'])) {
            rcube::raise_error(array(
                'code' => 401,
                'message' => 'jwt_auth: invalid or expired JWT'
            ), true, false);
            return $args;
        }

        $mailbox = $payload['mailbox'];
        $master = getenv('STALWART_MASTER_USER');
        if (!$master) {
            $master = 'master@master.local';
        }
        // Strip whitespace BEFORE the FQDN check — a YAML editor that
        // accidentally adds a trailing space or newline would
        // produce `"master@master.local "`, which Stalwart rejects
        // with the same opaque AUTHENTICATIONFAILED message as the
        // bare-name case. trim() catches both the bare-name AND the
        // whitespace-padded variants.
        $master = trim($master);
        // Stalwart 0.16's IMAP master-auth requires the FQDN form
        // (verified empirically 2026-05-07: `master` returns
        // AUTHENTICATIONFAILED localhost.local; `master@master.local`
        // succeeds). Older deployments may have STALWART_MASTER_USER
        // set to the bare `master` short name from secret.example.yaml
        // before the 2026-05-07 fix landed — auto-promote to FQDN
        // here so the plugin keeps working through the upgrade
        // window. The bootstrap.sh + secret.example.yaml now write
        // the FQDN form natively; this auto-promotion is a defence-
        // in-depth safety-net.
        if (strpos($master, '@') === false) {
            $master = $master . '@master.local';
        }
        $master_pw = getenv('STALWART_MASTER_PASSWORD');
        if (!$master_pw) {
            rcube::raise_error(array(
                'code' => 500,
                'message' => 'jwt_auth: STALWART_MASTER_PASSWORD env var not set'
            ), true, false);
            return $args;
        }

        $rcmail = rcmail::get_instance();

        // If an old authenticated session exists for a different user, kill
        // it before creating a new one (defends against session fixation and
        // ensures a clean login state).
        if (!empty($_SESSION['user_id'])) {
            $rcmail->kill_session();
        }

        // Stalwart master mode: IMAP login with username = "<mailbox>%<master>"
        // authenticates as the master user but operates on the target mailbox.
        $sso_user = $mailbox . '%' . $master;
        $host = $rcmail->config->get('imap_host');

        // rcmail::login() opens the IMAP connection, verifies credentials,
        // creates/updates the rcube_user record, and writes user_id to
        // $_SESSION. It does NOT set the roundcube_sessauth cookie or
        // regenerate the session ID — index.php's normal login path does
        // those separately AFTER login() returns true. We mirror that
        // sequence here so the authenticated session survives to the next
        // request.
        $ok = $rcmail->login($sso_user, $master_pw, $host, false);
        if (!$ok) {
            rcube::raise_error(array(
                'code' => 401,
                'message' => 'jwt_auth: IMAP master-user auth failed for ' . $mailbox,
            ), true, false);
            return $args;
        }

        // Stash the clean mailbox address so on_logged_in can rewrite
        // the user's primary identity AND so on_template_object_username
        // / on_render_page can substitute the clean form into the
        // rendered HTML on every subsequent request.
        //
        // CRITICAL: do NOT write `$_SESSION['username'] = $mailbox`
        // here. Roundcube's IMAP layer reads $_SESSION['username']
        // verbatim on EVERY request to authenticate the IMAP
        // connection — overwriting it to the clean form makes the
        // first AUTH PLAIN succeed (the master_pw + master form was
        // used in rcmail::login() above) but every subsequent IMAP
        // operation reuses session values, sees clean form +
        // master_pw, and Stalwart returns "AUTHENTICATE PLAIN:
        // Authentication failed" — which the user sees as
        // "Connection to storage server failed" + "Server Error:
        // AUTHENTICATE PLAIN: Authentication failed". Verified
        // empirically 2026-05-07.
        $_SESSION['jwt_auth::clean_user'] = $mailbox;

        // Mirror index.php's post-login sequence (see /var/www/html/index.php
        // around line 120): remove the 'temp' flag, regenerate session id
        // (without destroying — carry over user_id), and set the auth cookie
        // so Roundcube's session->authenticate() check on the next request
        // matches.
        $rcmail->session->remove('temp');
        $rcmail->session->regenerate_id(false);
        $rcmail->session->set_auth_cookie();

        $rcmail->log_login();

        // Run the login_after hook so other plugins see a normal login.
        $redir = $rcmail->plugins->exec_hook('login_after', array('_task' => 'mail'));
        unset($redir['abort'], $redir['_err']);

        // Redirect the browser to the authenticated mail view. The
        // session cookies (roundcube_sessid + roundcube_sessauth) have
        // been Set-Cookie'd on this response.
        $rcmail->output->redirect($redir, 0, true);
        // redirect() calls exit() internally, but be explicit.
        exit;
    }

    /**
     * After a JWT-driven login succeeds, normalize ALL persisted
     * references to the user — both the rcube_users.username row
     * AND every rcube_identities row owned by that user — back to
     * the clean mailbox form. Stalwart's master-auth syntax uses
     * `<mailbox>%<master>` as the IMAP login, so rcmail::login()
     * stamps that string into both tables. Two failure modes if we
     * leave it:
     *   1. Settings → Identities surfaces the master-form to the
     *      operator (UI leak).
     *   2. The SMTP MAIL FROM and From: header use the identity
     *      email; Stalwart rejects the master-form sender with
     *      "501 5.1.8 Bad sender's system address" → outbound mail
     *      fails entirely.
     *
     * We do NOT overwrite $_SESSION['username'] here — see the
     * comment in on_startup() above for why that breaks IMAP auth
     * on subsequent requests.
     *
     * Idempotent: a row whose email/name/username is already in the
     * clean form is left untouched. Iterates ALL identities (not
     * just the primary) so a second-identity leak from a previous
     * login also gets cleaned up.
     */
    function on_logged_in($args)
    {
        if (empty($_SESSION['jwt_auth::clean_user'])) {
            return $args;
        }
        $clean = $_SESSION['jwt_auth::clean_user'];
        $local = strpos($clean, '@') !== false ? substr($clean, 0, strpos($clean, '@')) : $clean;
        $rcmail = rcmail::get_instance();
        if (!$rcmail->user || !$rcmail->user->ID) {
            return $args;
        }

        // Rewrite users.username if it still carries the master
        // suffix. Roundcube's rcube_user object exposes save_prefs()
        // for prefs but no direct setter for username, so we go
        // through rcube_db.
        if (!empty($rcmail->user->data['username']) && strpos($rcmail->user->data['username'], '%') !== false) {
            $db = $rcmail->get_dbh();
            $db->query(
                'UPDATE ' . $db->table_name('users', true)
                . ' SET username = ? WHERE user_id = ?',
                $clean,
                $rcmail->user->ID
            );
            // Mirror into the in-memory user object so the rest of
            // this request sees the clean form.
            $rcmail->user->data['username'] = $clean;
        }

        // Rewrite EVERY identity owned by this user that still has
        // the master-form. Some users accumulated extra identities
        // before the fix landed; this loop catches all of them.
        $identities = $rcmail->user->list_identities();
        foreach ($identities as $ident) {
            $needs_email = !empty($ident['email']) && strpos($ident['email'], '%') !== false;
            $needs_name  = empty($ident['name']) || strpos($ident['name'], '%') !== false;
            if (!$needs_email && !$needs_name) {
                continue;
            }
            $update = array();
            if ($needs_email) {
                $update['email'] = $clean;
            }
            if ($needs_name) {
                $update['name'] = $local;
            }
            $rcmail->user->update_identity($ident['identity_id'], $update);
        }
        return $args;
    }

    /**
     * Replace the rendered top-right username string with the clean
     * mailbox form. The plugin hook `template_object_username` fires
     * whenever Roundcube renders the `username` template object
     * (top-right corner of the toolbar in every template).
     *
     * MUST NOT mutate $_SESSION['username'] — that field is read on
     * every request to authenticate the IMAP connection, so changing
     * it from the master-form `<mailbox>%<master>@master.local` to
     * the clean form breaks AUTH PLAIN on subsequent requests.
     */
    function on_template_object_username($args)
    {
        if (!empty($_SESSION['jwt_auth::clean_user'])) {
            $args['content'] = $_SESSION['jwt_auth::clean_user'];
        }
        return $args;
    }

    /**
     * Defence-in-depth: substitute any leaked master-form occurrences
     * in the rendered HTML with the clean form. Catches strings that
     * the template-object hook misses (e.g. tooltips, hidden inputs,
     * the Settings → Identities row that pre-populates from the user
     * record before the on_logged_in identity-rewrite has run).
     */
    function on_render_page($args)
    {
        if (empty($_SESSION['jwt_auth::clean_user'])) {
            return $args;
        }
        $clean  = $_SESSION['jwt_auth::clean_user'];
        $master = getenv('STALWART_MASTER_USER') ?: 'master@master.local';
        $master = trim($master);
        if (strpos($master, '@') === false) {
            $master = $master . '@master.local';
        }
        // The master-form substring we must scrub: `<clean>%<master>`.
        // Compose it once and replace every literal occurrence.
        $needle = $clean . '%' . $master;
        if (isset($args['content']) && is_string($args['content']) && strpos($args['content'], $needle) !== false) {
            $args['content'] = str_replace($needle, $clean, $args['content']);
        }
        return $args;
    }

    /**
     * Verify an HS256 JWT and return the decoded payload, or null on failure.
     *
     * Defense-in-depth order:
     *   1. Split into 3 parts.
     *   2. Decode and validate the header FIRST — require alg=HS256 and
     *      typ=JWT. Rejecting unknown algs before touching the HMAC
     *      eliminates any possibility of an "alg: none" structural bypass.
     *   3. Only then compute the HMAC and compare in constant time.
     *   4. Decode the payload and enforce time-based claims. `exp` is
     *      required unconditionally — a token without an expiry claim is
     *      rejected, so a misconfigured signer can never mint an immortal
     *      token.
     */
    private function verify_jwt($jwt, $secret)
    {
        $parts = explode('.', $jwt);
        if (count($parts) !== 3) {
            return null;
        }
        list($header_b64, $payload_b64, $sig_b64) = $parts;

        // 1) Decode and validate header BEFORE touching the HMAC.
        $header = json_decode($this->base64url_decode($header_b64), true);
        if (!is_array($header)) {
            return null;
        }
        if (($header['alg'] ?? '') !== 'HS256') {
            return null;
        }
        if (isset($header['typ']) && $header['typ'] !== 'JWT') {
            return null;
        }

        // 2) Verify signature in constant time.
        $expected_sig = $this->base64url_encode(
            hash_hmac('sha256', "$header_b64.$payload_b64", $secret, true)
        );
        if (!hash_equals($expected_sig, $sig_b64)) {
            return null;
        }

        // 3) Decode payload and enforce time-based claims.
        $payload = json_decode($this->base64url_decode($payload_b64), true);
        if (!is_array($payload)) {
            return null;
        }

        $now = time();

        // `exp` is REQUIRED. A token without an expiry is rejected.
        if (empty($payload['exp']) || (int) $payload['exp'] < $now) {
            return null;
        }

        // `nbf` (not-before) is optional but enforced when present.
        if (isset($payload['nbf']) && (int) $payload['nbf'] > $now) {
            return null;
        }

        // Reject tokens dated too far in the future (clock skew attack).
        // 60s of skew tolerance matches common JWT library defaults.
        if (isset($payload['iat']) && (int) $payload['iat'] > $now + 60) {
            return null;
        }

        return $payload;
    }

    private function base64url_encode($data)
    {
        return rtrim(strtr(base64_encode($data), '+/', '-_'), '=');
    }

    private function base64url_decode($data)
    {
        $remainder = strlen($data) % 4;
        if ($remainder) {
            $data .= str_repeat('=', 4 - $remainder);
        }
        return base64_decode(strtr($data, '-_', '+/'));
    }
}
