scenario "pair-ping" {
  title             = "Pair Ping"
  category          = "networking"
  tags              = ["linux", "networking", "multi-vm"]
  difficulty        = "easy"
  estimated_minutes = 10
  description       = "Restore a two-VM service path between a web client and a database peer"
  briefing          = <<-MD
    Two small Debian machines share one isolated run network. The `db` VM should
    publish a tiny HTTP endpoint, and the `web` VM should be able to reach it by
    using the peer address injected into the runtime environment.

    Fix the database service so the web-side connectivity check passes.
  MD

  hint "check-the-db-service" {
    title = "Start on db"
    body  = "Check `systemctl status intar-peer-db` on the db VM before changing the client."
  }

  hint "use-the-peer-runtime-variable" {
    title = "Use the peer address"
    body  = "On web, `echo $INTAR_PEER_DB_IP` shows the db VM address assigned for this run."
  }

  solution {
    body = <<-MD
      Start and enable the database peer HTTP service:

      ```bash
      sudo systemctl enable --now intar-peer-db
      curl "http://$INTAR_PEER_DB_IP:8080/health.json"
      ```

      The service serves `/srv/intar-peer/health.json`; the web probe passes when
      that endpoint returns `{"ok": true}` from the db peer.
    MD
  }

  image "debian-13-generic" {
    base = "trixie"
  }

  kino {
    defaults {
      every_seconds   = 2
      timeout_seconds = 2
    }

    probe "db-service-running" {
      kind        = "service"
      service     = "intar-peer-db"
      state       = "running"
      phase       = "scenario"
      description = "The db HTTP service should be running"
      title       = "Start the db service"
      body        = "The peer endpoint is unavailable until the db-side systemd service is active."

      hint "systemctl" {
        body = "`sudo systemctl enable --now intar-peer-db` starts the peer endpoint and keeps it active."
      }
    }

    probe "db-port-open" {
      kind        = "port_open"
      host        = "127.0.0.1"
      port        = 8080
      protocol    = "tcp"
      phase       = "scenario"
      description = "The db VM should listen on TCP port 8080"
      title       = "Open the db port"
      body        = "The local HTTP listener on db must be bound before web can connect."
    }

    probe "web-can-reach-db" {
      kind        = "command_json_path"
      argv        = ["/usr/bin/env", "python3", "-c", "import json, os, urllib.request; ip=os.environ.get('INTAR_PEER_DB_IP', ''); ok=False\ntry:\n    with urllib.request.urlopen(f'http://{ip}:8080/health.json', timeout=1.5) as r:\n        ok = (r.status == 200 and json.loads(r.read().decode()).get('ok') is True)\nexcept Exception:\n    ok = False\nprint(json.dumps({'db': {'reachable': ok}}))"]
      json_path   = "$.db.reachable"
      expected    = true
      phase       = "scenario"
      description = "The web VM should reach the db VM over the run network"
      title       = "Reach db from web"
      body        = "The web VM must use its run-scoped db peer address to fetch the health endpoint."

      hint "curl" {
        body = "`curl http://$INTAR_PEER_DB_IP:8080/health.json` should return the db health JSON from web."
      }
    }
  }

  vm "db" {
    cpu      = 1
    memory   = 512
    disk     = 3
    image    = "debian-13-generic"
    packages = ["python3"]

    step "install-peer-service" {
      command {
        cmd = <<-SHELL
          install -d -m 0755 /srv/intar-peer
          printf '{"ok": true, "service": "db"}\n' >/srv/intar-peer/health.json
          cat >/etc/systemd/system/intar-peer-db.service <<'EOF'
          [Unit]
          Description=Intar pair-ping db HTTP endpoint
          After=network-online.target
          Wants=network-online.target

          [Service]
          Type=simple
          WorkingDirectory=/srv/intar-peer
          ExecStart=/usr/bin/python3 -m http.server 8080 --bind 0.0.0.0
          Restart=always
          RestartSec=1

          [Install]
          WantedBy=multi-user.target
          EOF
          systemctl daemon-reload
          systemctl enable intar-peer-db
        SHELL
      }
    }

    step "stop-peer-service" {
      systemctl {
        unit   = "intar-peer-db"
        action = "stop"
      }
    }

    probes = ["db-service-running", "db-port-open"]
  }

  vm "web" {
    cpu      = 1
    memory   = 512
    disk     = 3
    image    = "debian-13-generic"
    packages = ["curl", "python3"]

    probes = ["web-can-reach-db"]
  }
}
