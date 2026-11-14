scenario "broken-nginx" {
  title      = "Fix the broken web server"
  summary    = "nginx is down and the default site is gone. Bring the website back."
  difficulty = "easy"
  minutes    = 10
  tags       = ["linux", "nginx", "systemd"]
  briefing   = <<-MD
    Visitors get nothing from this server. Find out why and bring the site back.
  MD
  solution   = <<-MD
    ```bash
    sudo systemctl enable --now nginx
    sudo ln -s /etc/nginx/sites-available/default /etc/nginx/sites-enabled/default
    sudo systemctl reload nginx
    ```
  MD

  machine "webserver" {
    cpu      = 1
    memory   = "512Mi"
    disk     = "4Gi"
    from     = "trixie"
    packages = ["nginx"]

    setup "break-nginx" {
      run = <<-SH
        systemctl disable nginx
        rm /etc/nginx/sites-enabled/default
      SH
    }
  }

  task "nginx-running" {
    title = "Start the web server"
    body  = "Get the web server running so people can use the website again."
    check { service = "nginx" }
    check {
      service = "nginx"
      state   = "enabled"
      fail    = "nginx runs now, but it will not come back after a reboot."
    }
    solve { run = "systemctl enable --now nginx" }
    hint "status" { body = "`systemctl status nginx` shows whether nginx is active and why it failed." }
  }

  task "default-site-enabled" {
    title = "Restore the default site"
    check { file = "/etc/nginx/sites-enabled/default" }
    solve {
      run = <<-SH
        ln -s /etc/nginx/sites-available/default /etc/nginx/sites-enabled/default
        systemctl reload nginx
      SH
    }
    hint "symlink" { body = "Compare `/etc/nginx/sites-available/` with `/etc/nginx/sites-enabled/`." }
  }

  task "site-reachable" {                       # implied: no solve
    title = "Make the site reachable"
    needs = ["nginx-running", "default-site-enabled"]
    check {
      http     = "http://127.0.0.1/"
      status   = 200
      contains = "Welcome to nginx"
    }
  }
}
