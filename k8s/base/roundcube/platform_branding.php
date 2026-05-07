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
        $this->add_hook('html_head', [$this, 'inject_branding_css']);
    }

    /**
     * Roundcube's html_head hook receives the rendered <head>
     * content as $args['content']. Append a <link> for our
     * stylesheet. Cache-bust by stable filename — the ConfigMap
     * carries the file content; a content change triggers a new
     * pod with a fresh emptyDir, so browsers naturally pick up
     * the new CSS on next session.
     */
    public function inject_branding_css($args)
    {
        $link = '<link rel="stylesheet" href="/branding/branding.css">';
        $args['content'] = (isset($args['content']) ? $args['content'] : '') . $link;
        return $args;
    }
}
