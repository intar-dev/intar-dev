---
title: Broken Nginx
summary: Bring a stopped website back online.
category: web
tags: [nginx, systemd, linux]
difficulty: easy
estimated_minutes: 15
---

Nginx is a web server. It accepts HTTP requests and returns website content.
For a website to work, the Nginx service must run and an enabled site
configuration must be valid.

## Service state

On a systemd system, a service can be enabled, running, both, or neither.
Enabled means systemd starts it during boot. Running means it is active now.
Check the service state before you change configuration files. This tells you
whether the problem is with the service, its configuration, or both.

## Nginx site configuration

Debian stores available Nginx site configurations in
`/etc/nginx/sites-available/`. It uses
`/etc/nginx/sites-enabled/` to select the configurations Nginx loads. The
standard default website needs a valid enabled entry. After you repair a site,
verify that Nginx can accept connections on HTTP port 80.

## Task

A routine change left the website down. Find what is wrong and get the default
website working again. Verify that the web server runs, the site is reachable,
and the default configuration is enabled.
