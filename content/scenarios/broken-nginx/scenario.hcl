scenario "broken-nginx" {
  title             = "Broken Nginx"
  category          = "web"
  tags              = ["nginx", "systemd", "linux"]
  difficulty        = "easy"
  estimated_minutes = 15
  description       = "Bring a stopped website back online."
  briefing          = <<-MD
    A routine change left the website down. Find what is wrong and get the default website working again.
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
      description = "The web server is running"
      title       = "Start the web server"
      body        = "Get the web server running so people can use the website again."

      hint "status" {
        body = "`systemctl status nginx` shows whether nginx is active and why it failed."
      }
    }

    probe "port-80-open" {
      kind        = "port_open"
      host        = "127.0.0.1"
      port        = 80
      protocol    = "tcp"
      description = "The site is reachable"
      title       = "Make the site reachable"
      body        = "Make sure people can reach the website again."

      hint "ss" {
        body = "`ss -ltnp` can show which process, if any, is bound to port 80."
      }
    }

    probe "default-site-enabled" {
      kind        = "file_exists"
      path        = "/etc/nginx/sites-enabled/default"
      description = "The default site is restored"
      title       = "Restore the default site"
      body        = "Bring back the standard site so visitors see the website they expect."

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
