FROM php:8.4-fpm-alpine AS base

RUN apk add --no-cache \
    nginx \
    supervisor \
    curl \
    zip unzip \
    libpng-dev libjpeg-turbo-dev freetype-dev \
    icu-dev \
    libzip-dev \
  && docker-php-ext-configure gd --with-freetype --with-jpeg \
  && docker-php-ext-install -j$(nproc) \
    gd pdo_mysql mysqli intl zip opcache bcmath \
  && rm -rf /var/cache/apk/*

# Non-root user for PHP-FPM
RUN adduser -D -u 1000 webuser

# NGINX config
COPY nginx.conf /etc/nginx/http.d/default.conf

# PHP-FPM config
RUN sed -i 's/^user = .*/user = webuser/' /usr/local/etc/php-fpm.d/www.conf \
  && sed -i 's/^group = .*/group = webuser/' /usr/local/etc/php-fpm.d/www.conf \
  && sed -i 's/^listen = .*/listen = 127.0.0.1:9000/' /usr/local/etc/php-fpm.d/www.conf

# PHP production settings
RUN cp /usr/local/etc/php/php.ini-production /usr/local/etc/php/conf.d/production.ini

# Supervisor to run nginx + php-fpm
COPY supervisord.conf /etc/supervisor.d/hosting.ini

# Document root
RUN mkdir -p /var/www/html && chown -R webuser:webuser /var/www/html
WORKDIR /var/www/html

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD curl -f http://localhost/health || exit 1

CMD ["supervisord", "-n", "-c", "/etc/supervisord.conf"]
