FROM wordpress:php8.4-apache

RUN apt-get update && apt-get install -y --no-install-recommends \
    less curl \
  && apt-get clean && rm -rf /var/lib/apt/lists/*

# Install WP-CLI
RUN curl -o /usr/local/bin/wp https://raw.githubusercontent.com/wp-cli/builds/gh-pages/phar/wp-cli.phar \
  && chmod +x /usr/local/bin/wp

# OPcache tuning for WordPress
RUN echo "opcache.memory_consumption=128\n\
opcache.interned_strings_buffer=16\n\
opcache.max_accelerated_files=10000\n\
opcache.revalidate_freq=60\n\
opcache.enable_cli=0" > /usr/local/etc/php/conf.d/opcache-wp.ini

# Upload limits
RUN echo "upload_max_filesize = 64M\n\
post_max_size = 64M\n\
memory_limit = 256M\n\
max_execution_time = 300" > /usr/local/etc/php/conf.d/uploads.ini

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD curl -f http://localhost/ || exit 1
