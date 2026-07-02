scenario "broken-nginx" {
  category = "web"
  description = "Fix a misconfigured nginx server"

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
    }

    probe "port-80-open" {
      kind        = "port_open"
      host        = "127.0.0.1"
      port        = 80
      protocol    = "tcp"
      description = "HTTP port 80 should be listening"
    }

    probe "default-site-enabled" {
      kind        = "file_exists"
      path        = "/etc/nginx/sites-enabled/default"
      description = "Default site should be enabled in /etc/nginx/sites-enabled"
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
