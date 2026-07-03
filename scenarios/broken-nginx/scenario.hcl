scenario "broken-nginx" {
  title             = "Broken Nginx"
  category          = "web"
  tags              = ["nginx", "systemd", "linux"]
  difficulty        = "easy"
  estimated_minutes = 15
  description       = "Fix a misconfigured nginx server"
  briefing          = <<-MD
    The web team pushed a small cleanup and the default site stopped responding.
    Bring nginx back online and make sure the default site is enabled again.
  MD

  hint "start-with-the-service" {
    title = "Check nginx first"
    body  = "Before editing files, verify whether the nginx service is running and enabled."
  }

  hint "look-at-sites-enabled" {
    title = "Check the enabled site"
    body  = "The default site should have an entry under `/etc/nginx/sites-enabled/`."
  }

  solution {
    body = <<-MD
      Enable and start nginx, then restore the default site symlink:

      ```bash
      sudo systemctl enable --now nginx
      sudo ln -s /etc/nginx/sites-available/default /etc/nginx/sites-enabled/default
      sudo systemctl reload nginx
      ```
    MD
  }

  image "debian-13-generic" {
    base = "trixie"
  }

  kino {
    defaults {
      every_seconds = 2
      timeout_seconds = 2
    }

    probe "nginx-running" {
      kind        = "service"
      service     = "nginx"
      state       = "running"
      description = "Nginx should be running to serve the default site"
      title       = "Start nginx"
      body        = "The HTTP server process needs to be active before the site can answer requests."

      hint "status" {
        body = "`systemctl status nginx` shows whether nginx is active and why it failed."
      }
    }

    probe "port-80-open" {
      kind        = "port_open"
      host        = "127.0.0.1"
      port        = 80
      protocol    = "tcp"
      description = "HTTP port 80 should be listening"
      title       = "Open HTTP"
      body        = "Once nginx is running, confirm it is listening on the standard HTTP port."

      hint "ss" {
        body = "`ss -ltnp` can show which process, if any, is bound to port 80."
      }
    }

    probe "default-site-enabled" {
      kind        = "file_exists"
      path        = "/etc/nginx/sites-enabled/default"
      description = "Default site should be enabled in /etc/nginx/sites-enabled"
      title       = "Restore the default site"
      body        = "The default site must be present in nginx's enabled-sites directory."

      hint "symlink" {
        body = "Compare `/etc/nginx/sites-available/default` with `/etc/nginx/sites-enabled/default`."
      }
    }
  }

  vm "webserver" {
    cpu    = 1
    memory = 512
    disk   = 4
    image  = "debian-13-generic"
    packages = ["nginx", "curl"]

    step "break-nginx" {
      systemctl {
        unit   = "nginx"
        action = "disable"
      }

      file_delete {
        path = "/etc/nginx/sites-enabled/default"
      }
    }

    probes = ["nginx-running", "port-80-open", "default-site-enabled"]
  }
}
