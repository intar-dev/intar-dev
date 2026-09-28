---
title: Operate before you repair
summary: Use a safe, repeatable method before you change a Linux service.
category: linux
tags: [linux, operations, troubleshooting]
estimated_minutes: 8
---

Reliable repairs start with evidence. Before you change a service, establish
what should happen, what is happening now, and what changed. This method makes
repairs safer and makes the result easier to verify.

## Observe the service

Start with the user-visible symptom. Then inspect the service state, recent
logs, and relevant configuration. Commands such as `systemctl status`,
`journalctl -u <service>`, and `ss -ltnp` help you identify whether the issue
is a stopped service, a bad configuration, or a missing network listener.

## Change one thing at a time

Choose the smallest change that addresses the evidence. Keep the previous
state clear so you can reverse the change if it does not work. Do not restart a
service repeatedly without checking its status and logs after each change.

## Verify the repair

Check both the service and the result that users need. A running service alone
is not enough. For a website, confirm that it listens on the expected port and
returns a successful HTTP response. Record what you changed and why.

Complete this lecture to unlock the repair exercise. Use this operating model
while you diagnose the next unit.
