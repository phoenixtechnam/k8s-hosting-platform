<?php
/*
 * platform_branding — Roundcube plugin
 *
 * Single responsibility: inject /branding/branding.css into every
 * Roundcube page's <head> via the html_head hook.
 *
 * Why a real plugin (not an *.inc.php hook):
 *   Roundcube's docker entrypoint includes *.inc.php files DURING
 *   config load (rcmail singleton boot). Calling rcmail::get_instance()
 *   from that path triggers infinite recursion. Plugins are loaded
 *   AFTER the singleton finishes building, so add_hook() is safe here.
 *
 * Mount layout (k8s/base/roundcube/deployment.yaml wrapper script):
 *   /var/www/html/plugins/platform_branding/platform_branding.php
 *   /var/www/html/branding/branding.css
 *   /var/www/html/branding/logo.svg
 *
 * Loaded via $config['plugins'][] = 'platform_branding' set in
 * branding.inc.php.
 */

class platform_branding extends rcube_plugin
{
    /**
     * Roundcube loads plugins for both the auth (login) page and
     * post-login UI. Empty $task means: register on every task.
     */
    public $task = '.*';

    public function init()
    {
        // Roundcube has no `html_head` hook (verified empirically
        // 2026-05-07: grep'd /var/www/html/program/include/
        // rcmail_output_html.php for exec_hook calls; the rendering
        // pipeline only exposes render_page / send_page /
        // template_object_* / loginform_content). `send_page` fires
        // with the full rendered HTML in $args['content'] just
        // before flushing to the client, which is the cleanest
        // injection point for an extra <link>.
        $this->add_hook('send_page', [$this, 'inject_branding_css']);
    }

    /**
     * Inject /branding/branding.css just before </head> on every
     * Roundcube page (login + post-login). Uses str_replace on the
     * first </head> only so the body unchanged. If the page has
     * no </head> (defensive — shouldn't happen), the original
     * content is returned untouched.
     */
    public function inject_branding_css($args)
    {
        if (empty($args['content']) || !is_string($args['content'])) {
            return $args;
        }
        $needle = '</head>';
        $pos = stripos($args['content'], $needle);
        if ($pos === false) {
            return $args;
        }
        $link = '<link rel="stylesheet" href="/branding/branding.css">';
        $args['content'] = substr($args['content'], 0, $pos)
            . $link
            . substr($args['content'], $pos);
        return $args;
    }
}
