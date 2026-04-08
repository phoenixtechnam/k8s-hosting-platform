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
        $this->add_hook('logged_in', array($this, 'on_logged_in'));
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
            $master = 'master';
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

        // Stash the clean mailbox address so on_logged_in can rewrite the
        // displayed username in the Roundcube UI.
        $_SESSION['jwt_auth::clean_user'] = $mailbox;
        $_SESSION['username'] = $mailbox;

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
     * After a JWT-driven login succeeds, rewrite the displayed username so
     * the UI shows the clean mailbox address instead of "<mailbox>%<master>".
     */
    function on_logged_in($args)
    {
        if (!empty($_SESSION['jwt_auth::clean_user'])) {
            $clean = $_SESSION['jwt_auth::clean_user'];
            $_SESSION['username'] = $clean;
            unset($_SESSION['jwt_auth::clean_user']);
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
