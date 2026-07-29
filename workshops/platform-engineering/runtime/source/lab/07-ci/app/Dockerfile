# Deliberately tiny: one static page served by busybox httpd.
# The base is copied from its reviewed external digest into learner-owned Zot
# before this build. The resulting learner artifact is intentionally addressed
# by its local workshop tag; no mutable external tag is pulled.
FROM zot.zot.svc.cluster.local:5000/library/busybox:1.37.0
COPY index.html /www/index.html
EXPOSE 8080
CMD ["httpd", "-f", "-p", "8080", "-h", "/www"]
